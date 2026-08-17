import prisma from '../../database/prisma';
import { config } from '../../config';
import { decrypt } from '../../utils/security';
import { identityHash } from '../linking/identity';
import { NitradoClient } from '../nitrado/nitradoClient';
import { sanitizeLeaveCleanupError } from './leaveCleanupSecurity';

export type LeaveWhitelistStepState = 'DONE' | 'WAITING';

export interface LeaveWhitelistStepResult {
  state: LeaveWhitelistStepState;
  links: number;
  names: number;
  localMarked: number;
  localDeleted: number;
  requestsDeleted: number;
  addJobsNeutralized: number;
  removeJobsQueued: number;
  jobPayloadsScrubbed: number;
}

type LinkRow = {
  nitradoConnId: string;
  identityHash: string | null;
};

type ScopedJob = {
  id: string;
  operation: string;
  status: 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED' | 'DEAD';
  payload: unknown;
};

type WhitelistEntryRow = {
  id: string;
  gameId: string;
  syncState: 'LOCAL_ONLY' | 'SYNCED' | 'PENDING_REMOVE';
};

type WhitelistRequestRow = {
  id: string;
  gameId: string;
  requesterDiscordId: string;
};

function norm(value: string): string {
  return value.trim().toLocaleLowerCase('en-US');
}

function payloadGameId(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const value = (payload as Record<string, unknown>).gameId;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function sameTarget(job: ScopedJob, targetNames: Set<string>): boolean {
  const gameId = payloadGameId(job.payload);
  return gameId !== null && targetNames.has(norm(gameId));
}

async function trustedNamesForLink(
  guildId: string,
  nitradoConnId: string,
  linkHash: string,
): Promise<Set<string>> {
  const sessions = await prisma.playerSession.findMany({
    where: { guildId, nitradoConnId },
    select: { gameId: true, playerName: true },
    orderBy: { connectedAt: 'desc' },
    take: 5000,
  });

  const trusted = new Set<string>();
  for (const session of sessions) {
    if (!session.gameId || identityHash(session.gameId, config.security.encryptionKey) !== linkHash) continue;
    if (session.playerName?.trim()) trusted.add(norm(session.playerName));
  }
  return trusted;
}

async function readRemoteWhitelist(args: {
  guildId: string;
  nitradoConnId: string;
  targetNames: Set<string>;
}): Promise<{ identifiers: string[]; connectionActive: true }> {
  const conn = await prisma.nitradoConnection.findFirst({
    where: { id: args.nitradoConnId, guildId: args.guildId },
    select: { id: true, encryptedToken: true, nitradoServerId: true, status: true },
  });
  if (!conn) throw new Error('Leave-Whitelist: Nitrado-Connection im Guild-Scope nicht gefunden.');
  if (conn.status !== 'ACTIVE') throw new Error(`Leave-Whitelist: Nitrado-Connection ist ${conn.status}; Remote-Loeschung nicht bestaetigbar.`);
  if (!conn.nitradoServerId) throw new Error('Leave-Whitelist: Nitrado-Service-ID fehlt; Remote-Loeschung nicht bestaetigbar.');

  let token = '';
  try {
    token = decrypt(conn.encryptedToken, config.security.encryptionKey);
    const remote = await new NitradoClient(token).getWhitelist(conn.nitradoServerId);
    return { identifiers: remote.map(row => row.identifier).filter(Boolean), connectionActive: true };
  } catch (error) {
    const sensitive = [token, ...args.targetNames].filter(Boolean);
    throw new Error(`Leave-Whitelist Remote-Read fehlgeschlagen: ${sanitizeLeaveCleanupError(error, sensitive)}`);
  }
}

async function processLink(
  guildId: string,
  discordId: string,
  link: LinkRow,
): Promise<Omit<LeaveWhitelistStepResult, 'links'>> {
  if (!link.identityHash) throw new Error('Leave-Whitelist: VERIFIED Link ohne identityHash.');

  const trustedNames = await trustedNamesForLink(guildId, link.nitradoConnId, link.identityHash);
  if (trustedNames.size === 0) {
    throw new Error('Leave-Whitelist: verifizierte GUID kann nicht mehr sicher auf einen Spielernamen abgebildet werden.');
  }

  const [localRows, requestRows, jobs, remote] = await Promise.all([
    prisma.whitelistEntry.findMany({
      where: { guildId, nitradoConnId: link.nitradoConnId },
      select: { id: true, gameId: true, syncState: true },
    }) as Promise<WhitelistEntryRow[]>,
    prisma.whitelistRequest.findMany({
      where: { guildId, nitradoConnId: link.nitradoConnId },
      select: { id: true, gameId: true, requesterDiscordId: true },
    }) as Promise<WhitelistRequestRow[]>,
    prisma.nitradoJob.findMany({
      where: {
        guildId,
        nitradoConnId: link.nitradoConnId,
        operation: { in: ['WHITELIST_ADD', 'WHITELIST_REMOVE'] },
      },
      select: { id: true, operation: true, status: true, payload: true },
      orderBy: { createdAt: 'desc' },
      take: 1000,
    }) as Promise<ScopedJob[]>,
    readRemoteWhitelist({ guildId, nitradoConnId: link.nitradoConnId, targetNames: trustedNames }),
  ]);

  const matchingLocal = localRows.filter(row => trustedNames.has(norm(row.gameId)));
  const matchingRequests = requestRows.filter(row => trustedNames.has(norm(row.gameId)));
  const matchingRemote = remote.identifiers.filter(name => trustedNames.has(norm(name)));
  const targetNames = new Set<string>(trustedNames);
  for (const row of matchingLocal) targetNames.add(norm(row.gameId));
  for (const row of matchingRequests) targetNames.add(norm(row.gameId));
  for (const name of matchingRemote) targetNames.add(norm(name));

  const matchingJobs = jobs.filter(job => sameTarget(job, targetNames));
  const runningAdds = matchingJobs.filter(job => job.operation === 'WHITELIST_ADD' && job.status === 'RUNNING');
  const pendingAdds = matchingJobs.filter(job => job.operation === 'WHITELIST_ADD' && job.status === 'PENDING');
  const activeRemoves = matchingJobs.filter(job => job.operation === 'WHITELIST_REMOVE' && (job.status === 'PENDING' || job.status === 'RUNNING'));
  const deadRemoves = matchingJobs.filter(job => job.operation === 'WHITELIST_REMOVE' && (job.status === 'DEAD' || job.status === 'FAILED'));

  let localMarked = 0;
  let addJobsNeutralized = 0;
  let removeJobsQueued = 0;

  await prisma.$transaction(async tx => {
    if (matchingLocal.length > 0) {
      const marked = await tx.whitelistEntry.updateMany({
        where: {
          id: { in: matchingLocal.map(row => row.id) },
          guildId,
          nitradoConnId: link.nitradoConnId,
        },
        data: { syncState: 'PENDING_REMOVE', lastSyncedAt: null },
      });
      localMarked += marked.count;
    }

    if (matchingRequests.length > 0) {
      await tx.whitelistRequest.updateMany({
        where: {
          id: { in: matchingRequests.map(row => row.id) },
          guildId,
          nitradoConnId: link.nitradoConnId,
          status: { in: ['PENDING', 'APPROVED'] },
        },
        data: { status: 'CANCELLED' },
      });
    }

    if (pendingAdds.length > 0) {
      const neutralized = await tx.nitradoJob.updateMany({
        where: {
          id: { in: pendingAdds.map(job => job.id) },
          guildId,
          nitradoConnId: link.nitradoConnId,
          operation: 'WHITELIST_ADD',
          status: 'PENDING',
        },
        data: { status: 'DONE', payload: {}, lastError: null, updatedAt: new Date() },
      });
      addJobsNeutralized += neutralized.count;
    }

    // Ein RUNNING ADD kann gerade den per-Connection-Lock halten. In diesem
    // Zustand darf kein Remove eingeplant/finalisiert werden: beim naechsten
    // Saga-Pass ist der Add entweder DONE oder wieder PENDING und kann dann
    // sicher neutralisiert werden.
    if (runningAdds.length === 0 && matchingRemote.length > 0 && activeRemoves.length === 0) {
      if (deadRemoves.length > 0) {
        throw new Error('Leave-Whitelist: vorheriger WHITELIST_REMOVE ist DEAD; manuelle Recovery erforderlich.');
      }
      for (const gameId of matchingRemote) {
        await tx.nitradoJob.create({
          data: {
            guildId,
            nitradoConnId: link.nitradoConnId,
            operation: 'WHITELIST_REMOVE',
            payload: { gameId },
          },
        });
        removeJobsQueued++;
      }
    }
  });

  if (runningAdds.length > 0) {
    return {
      state: 'WAITING', links: undefined as never, names: trustedNames.size,
      localMarked, localDeleted: 0, requestsDeleted: 0,
      addJobsNeutralized, removeJobsQueued, jobPayloadsScrubbed: 0,
    };
  }

  // Solange der Name beim frischen Remote-Read noch vorhanden ist, muss die
  // Outbox den Remove erst erfolgreich ausfuehren. Lokal bleibt PENDING_REMOVE.
  if (matchingRemote.length > 0) {
    return {
      state: 'WAITING', links: undefined as never, names: trustedNames.size,
      localMarked, localDeleted: 0, requestsDeleted: 0,
      addJobsNeutralized, removeJobsQueued, jobPayloadsScrubbed: 0,
    };
  }

  const runningRemoves = matchingJobs.filter(job => job.operation === 'WHITELIST_REMOVE' && job.status === 'RUNNING');
  if (runningRemoves.length > 0) {
    return {
      state: 'WAITING', links: undefined as never, names: trustedNames.size,
      localMarked, localDeleted: 0, requestsDeleted: 0,
      addJobsNeutralized, removeJobsQueued, jobPayloadsScrubbed: 0,
    };
  }

  let localDeleted = 0;
  let requestsDeleted = 0;
  let jobPayloadsScrubbed = 0;
  await prisma.$transaction(async tx => {
    if (matchingLocal.length > 0) {
      const deleted = await tx.whitelistEntry.deleteMany({
        where: {
          id: { in: matchingLocal.map(row => row.id) },
          guildId,
          nitradoConnId: link.nitradoConnId,
          syncState: 'PENDING_REMOVE',
        },
      });
      localDeleted += deleted.count;
    }

    if (matchingRequests.length > 0) {
      const deleted = await tx.whitelistRequest.deleteMany({
        where: {
          id: { in: matchingRequests.map(row => row.id) },
          guildId,
          nitradoConnId: link.nitradoConnId,
        },
      });
      requestsDeleted += deleted.count;
    }

    const scrubCandidates = matchingJobs.filter(job => job.status !== 'RUNNING');
    if (scrubCandidates.length > 0) {
      const scrubbed = await tx.nitradoJob.updateMany({
        where: {
          id: { in: scrubCandidates.map(job => job.id) },
          guildId,
          nitradoConnId: link.nitradoConnId,
          operation: { in: ['WHITELIST_ADD', 'WHITELIST_REMOVE'] },
          status: { not: 'RUNNING' },
        },
        data: { payload: {}, lastError: null, updatedAt: new Date() },
      });
      jobPayloadsScrubbed += scrubbed.count;
    }
  });

  return {
    state: 'DONE', links: undefined as never, names: trustedNames.size,
    localMarked, localDeleted, requestsDeleted,
    addJobsNeutralized, removeJobsQueued, jobPayloadsScrubbed,
  };
}

/**
 * Interner Leave-1B-Saga-Schritt. Kein produktiver Trigger in dieser Etappe.
 * Mehrere verifizierte Links derselben Guild werden gameserverweise verarbeitet.
 */
export async function runLeaveWhitelistCleanupStep(
  guildId: string,
  discordId: string,
): Promise<LeaveWhitelistStepResult> {
  const links = await prisma.gameIdentityLink.findMany({
    where: { guildId, userDiscordId: discordId, status: 'VERIFIED', identityHash: { not: null } },
    select: { nitradoConnId: true, identityHash: true },
    orderBy: { createdAt: 'asc' },
  }) as LinkRow[];

  const total: LeaveWhitelistStepResult = {
    state: 'DONE', links: links.length, names: 0, localMarked: 0, localDeleted: 0,
    requestsDeleted: 0, addJobsNeutralized: 0, removeJobsQueued: 0, jobPayloadsScrubbed: 0,
  };

  for (const link of links) {
    let result: Omit<LeaveWhitelistStepResult, 'links'>;
    try {
      result = await processLink(guildId, discordId, link);
    } catch (error) {
      throw new Error(sanitizeLeaveCleanupError(error));
    }
    total.names += result.names;
    total.localMarked += result.localMarked;
    total.localDeleted += result.localDeleted;
    total.requestsDeleted += result.requestsDeleted;
    total.addJobsNeutralized += result.addJobsNeutralized;
    total.removeJobsQueued += result.removeJobsQueued;
    total.jobPayloadsScrubbed += result.jobPayloadsScrubbed;
    if (result.state === 'WAITING') total.state = 'WAITING';
  }

  // Request-History traegt die Discord-ID auch unabhaengig vom finalen Linknamen.
  // Erst wenn ALLE Gameserver-Scope-Schritte remote bestaetigt DONE sind, darf
  // diese personenbezogene lokale History guildweit entfernt werden.
  if (total.state === 'DONE') {
    const deleted = await prisma.whitelistRequest.deleteMany({
      where: { guildId, requesterDiscordId: discordId },
    });
    total.requestsDeleted += deleted.count;
  }

  return total;
}
