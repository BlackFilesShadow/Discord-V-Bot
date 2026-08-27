import prisma from '../../database/prisma';
import { config } from '../../config';
import { decrypt } from '../../utils/security';
import { identityHash } from '../linking/identity';
import { NitradoClient } from '../nitrado/nitradoClient';
import {
  readCurrentAdmBinding,
  withFreshAdmBinding,
  type AdmBindingSnapshot,
} from '../nitrado/adm/bindingFence';
import { enqueueWhitelistRemove, type WhitelistOutboxClient } from '../whitelist/whitelistOutbox';
import { sanitizeLeaveCleanupError } from './leaveCleanupSecurity';
import { updateGoodbyeCleanupServers } from '../welcome/goodbyeStatus';

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

type LinkStepResult = Omit<LeaveWhitelistStepResult, 'links'>;
type LinkRow = { nitradoConnId: string; identityHash: string | null };
type ScopedJob = {
  id: string;
  operation: string;
  status: 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED' | 'DEAD';
  payload: unknown;
  attempts: number;
  updatedAt: Date;
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

type RemoteWhitelistRead = {
  binding: AdmBindingSnapshot;
  identifiers: string[];
};

const SESSION_PAGE_SIZE = 1000;

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

function waitingResult(names: number, values: {
  localMarked: number;
  addJobsNeutralized: number;
  removeJobsQueued: number;
}): LinkStepResult {
  return {
    state: 'WAITING',
    names,
    localMarked: values.localMarked,
    localDeleted: 0,
    requestsDeleted: 0,
    addJobsNeutralized: values.addJobsNeutralized,
    removeJobsQueued: values.removeJobsQueued,
    jobPayloadsScrubbed: 0,
  };
}

async function trustedNamesForLink(
  guildId: string,
  nitradoConnId: string,
  linkHash: string,
): Promise<Set<string>> {
  const trusted = new Set<string>();
  let cursor: string | undefined;

  // Die Whitelist-Zuordnung darf nicht von einem willkuerlichen "letzte 5000"
  // Fenster abhaengen. Ein lange inaktiver, aber weiterhin verifiziert gelinkter
  // Spieler muss auch auf grossen Servern sicher gefunden werden. Deshalb wird
  // die komplette Session-Historie stabil und speicherschonend paginiert.
  for (;;) {
    const page = await prisma.playerSession.findMany({
      where: { guildId, nitradoConnId },
      select: { id: true, gameId: true, playerName: true },
      orderBy: { id: 'asc' },
      take: SESSION_PAGE_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    for (const session of page) {
      if (!session.gameId || identityHash(session.gameId, config.security.encryptionKey) !== linkHash) continue;
      if (session.playerName?.trim()) trusted.add(norm(session.playerName));
    }

    if (page.length < SESSION_PAGE_SIZE) break;
    cursor = page[page.length - 1]?.id;
    if (!cursor) break;
  }

  return trusted;
}

async function readRemoteWhitelist(args: {
  guildId: string;
  nitradoConnId: string;
  targetNames: Set<string>;
}): Promise<RemoteWhitelistRead> {
  let token = '';
  try {
    // Nitrado-1Q: Remote-Reads duerfen keinen ungeschuetzten Token-/Service-
    // Snapshot aus der DB tragen. Der Binding-Snapshot wird kurz unter dem
    // kanonischen Connection-Lock gelesen und danach fuer HTTP wieder geloest.
    const binding = await readCurrentAdmBinding({ id: args.nitradoConnId, guildId: args.guildId });
    if (!binding) {
      throw new Error('Leave-Whitelist: Nitrado-Connection ist nicht ACTIVE oder besitzt keine Service-ID.');
    }
    token = decrypt(binding.encryptedToken, config.security.encryptionKey);
    const remote = await new NitradoClient(token).getWhitelist(binding.nitradoServerId);
    return {
      binding,
      identifiers: remote.map(row => row.identifier).filter(Boolean),
    };
  } catch (error) {
    const sensitive = [token, ...args.targetNames].filter(Boolean);
    throw new Error(`Leave-Whitelist Remote-Read fehlgeschlagen: ${sanitizeLeaveCleanupError(error, sensitive)}`);
  }
}

async function listWhitelistJobs(guildId: string, nitradoConnId: string): Promise<ScopedJob[]> {
  return prisma.nitradoJob.findMany({
    where: {
      guildId,
      nitradoConnId,
      operation: { in: ['WHITELIST_ADD', 'WHITELIST_REMOVE'] },
    },
    select: { id: true, operation: true, status: true, payload: true, attempts: true, updatedAt: true },
    orderBy: { createdAt: 'desc' },
    take: 1000,
  }) as Promise<ScopedJob[]>;
}

async function processLink(
  guildId: string,
  link: LinkRow,
  cleanupRequestId?: string,
): Promise<LinkStepResult> {
  if (!link.identityHash) throw new Error('Leave-Whitelist: VERIFIED Link ohne identityHash.');

  // GameIdentityLink enthaelt den HMAC der GUID. Die Nitrado-Whitelist arbeitet
  // dagegen mit Player-Namen. Darum wird zuerst eine Session gesucht, deren
  // GUID exakt zum Link-HMAC passt; nur deren Namen sind Loeschziele.
  const trustedNames = await trustedNamesForLink(guildId, link.nitradoConnId, link.identityHash);
  if (trustedNames.size === 0) {
    if (cleanupRequestId) {
      await updateGoodbyeCleanupServers(cleanupRequestId, [{
        nitradoConnId: link.nitradoConnId,
        state: 'NOT_LINKED',
      }]);
    }
    return {
      state: 'DONE', names: 0, localMarked: 0, localDeleted: 0,
      requestsDeleted: 0, addJobsNeutralized: 0, removeJobsQueued: 0, jobPayloadsScrubbed: 0,
    };
  }

  const [localRows, requestRows, jobs, remoteRead] = await Promise.all([
    prisma.whitelistEntry.findMany({
      where: { guildId, nitradoConnId: link.nitradoConnId },
      select: { id: true, gameId: true, syncState: true },
    }) as Promise<WhitelistEntryRow[]>,
    prisma.whitelistRequest.findMany({
      where: { guildId, nitradoConnId: link.nitradoConnId },
      select: { id: true, gameId: true, requesterDiscordId: true },
    }) as Promise<WhitelistRequestRow[]>,
    listWhitelistJobs(guildId, link.nitradoConnId),
    readRemoteWhitelist({ guildId, nitradoConnId: link.nitradoConnId, targetNames: trustedNames }),
  ]);
  const binding = remoteRead.binding;
  const remoteIdentifiers = remoteRead.identifiers;

  const matchingLocal = localRows.filter(row => trustedNames.has(norm(row.gameId)));
  const matchingRequests = requestRows.filter(row => trustedNames.has(norm(row.gameId)));
  const matchingRemote = remoteIdentifiers.filter(name => trustedNames.has(norm(name)));
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

  if (deadRemoves.length > 0 && matchingRemote.length > 0) {
    if (cleanupRequestId) {
      await updateGoodbyeCleanupServers(cleanupRequestId, [{
        nitradoConnId: link.nitradoConnId,
        state: 'FAILED',
        error: 'Nitrado-Entfernung endgültig fehlgeschlagen',
      }]);
    }
    throw new Error('Leave-Whitelist: vorheriger WHITELIST_REMOVE ist DEAD; manuelle Recovery erforderlich.');
  }

  // Der Remote-Snapshot darf lokale Whitelist-Absicht und Outbox nur
  // beeinflussen, solange exakt dieselbe Token-/Service-/Binding-Version gilt.
  await withFreshAdmBinding(binding, () => prisma.$transaction(async tx => {
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

    // Ein RUNNING ADD kann gerade den per-Connection-Lock halten. Erst beim
    // naechsten Saga-Pass darf nach dessen Abschluss ein Remove entstehen.
    if (runningAdds.length === 0 && matchingRemote.length > 0 && activeRemoves.length === 0) {
      // Mehrere Subject-Locks werden innerhalb EINER Transaktion in stabiler
      // Reihenfolge erworben. Damit koennen zwei Multi-Name-Cleanups keinen
      // Lock-Order-Deadlock gegeneinander erzeugen.
      const orderedRemote = [...matchingRemote].sort((a, b) => norm(a).localeCompare(norm(b), 'en-US'));
      for (const gameId of orderedRemote) {
        const created = await enqueueWhitelistRemove(
          tx as unknown as WhitelistOutboxClient,
          { guildId, nitradoConnId: link.nitradoConnId },
          gameId,
        );
        if (created) removeJobsQueued++;
      }
    }
  }));

  if (runningAdds.length > 0 || matchingRemote.length > 0) {
    if (cleanupRequestId) {
      const activeRemove = activeRemoves[0];
      const state = activeRemove?.status === 'RUNNING'
        ? 'RUNNING'
        : activeRemove && activeRemove.attempts > 0 ? 'RETRY' : 'PENDING';
      await updateGoodbyeCleanupServers(cleanupRequestId, [{
        nitradoConnId: link.nitradoConnId,
        state,
        ...(matchingRemote.length > 0
          ? { playerNames: [...matchingRemote].sort((a, b) => a.localeCompare(b, 'de-DE')) }
          : {}),
      }]);
    }
    return waitingResult(trustedNames.size, { localMarked, addJobsNeutralized, removeJobsQueued });
  }

  // Remote ist im frischen Read bereits sauber. Vor dem lokalen Finalisieren
  // Jobs NOCHMALS lesen: so wird ein Add/Remove erfasst, das zwischen dem ersten
  // Snapshot und dem PENDING_REMOVE-Write entstanden ist.
  const freshJobs = (await listWhitelistJobs(guildId, link.nitradoConnId))
    .filter(job => sameTarget(job, targetNames));
  if (freshJobs.some(job => job.status === 'RUNNING')) {
    if (cleanupRequestId) {
      await updateGoodbyeCleanupServers(cleanupRequestId, [{ nitradoConnId: link.nitradoConnId, state: 'RUNNING' }]);
    }
    return waitingResult(trustedNames.size, { localMarked, addJobsNeutralized, removeJobsQueued });
  }

  const freshPendingAdds = freshJobs.filter(job => job.operation === 'WHITELIST_ADD' && job.status === 'PENDING');
  let localDeleted = 0;
  let requestsDeleted = 0;
  let jobPayloadsScrubbed = 0;

  // Zweite Freshness-Grenze: auch zwischen erstem Intent-Commit, erneutem
  // Job-Snapshot und finaler lokaler Loeschung kann ein Service-Rebind liegen.
  await withFreshAdmBinding(binding, () => prisma.$transaction(async tx => {
    if (freshPendingAdds.length > 0) {
      const neutralized = await tx.nitradoJob.updateMany({
        where: {
          id: { in: freshPendingAdds.map(job => job.id) },
          guildId,
          nitradoConnId: link.nitradoConnId,
          operation: 'WHITELIST_ADD',
          status: 'PENDING',
        },
        data: { status: 'DONE', payload: {}, lastError: null, updatedAt: new Date() },
      });
      addJobsNeutralized += neutralized.count;
    }

    const pendingRemoves = freshJobs.filter(job => job.operation === 'WHITELIST_REMOVE' && job.status === 'PENDING');
    if (pendingRemoves.length > 0) {
      await tx.nitradoJob.updateMany({
        where: {
          id: { in: pendingRemoves.map(job => job.id) },
          guildId,
          nitradoConnId: link.nitradoConnId,
          operation: 'WHITELIST_REMOVE',
          status: 'PENDING',
        },
        data: { status: 'DONE', payload: {}, lastError: null, updatedAt: new Date() },
      });
    }

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

    const scrubCandidates = freshJobs.filter(job => job.status !== 'RUNNING');
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
  }));

  if (cleanupRequestId) {
    const completedRemove = freshJobs.find(job => job.operation === 'WHITELIST_REMOVE' && job.status === 'DONE');
    const hadRemoveIntent = matchingJobs.some(job => job.operation === 'WHITELIST_REMOVE')
      || freshJobs.some(job => job.operation === 'WHITELIST_REMOVE');
    await updateGoodbyeCleanupServers(cleanupRequestId, [{
      nitradoConnId: link.nitradoConnId,
      state: hadRemoveIntent ? 'CONFIRMED' : 'NOT_PRESENT',
      ...(hadRemoveIntent ? { confirmedAt: (completedRemove?.updatedAt ?? new Date()).toISOString() } : {}),
    }]);
  }

  return {
    state: 'DONE',
    names: trustedNames.size,
    localMarked,
    localDeleted,
    requestsDeleted,
    addJobsNeutralized,
    removeJobsQueued,
    jobPayloadsScrubbed,
  };
}

/**
 * Interner Leave-1B-Saga-Schritt. Kein produktiver Trigger in dieser Etappe.
 * Mehrere verifizierte Links derselben Guild werden gameserverweise verarbeitet.
 */
export async function runLeaveWhitelistCleanupStep(
  guildId: string,
  discordId: string,
  cleanupRequestId?: string,
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
    let result: LinkStepResult;
    try {
      result = await processLink(guildId, link, cleanupRequestId);
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

  if (total.state === 'DONE') {
    // Ein APPROVED Request, der nach allen verifizierten Links noch existiert,
    // koennte remote einen Namen repraesentieren, dessen Eigentum nicht mehr
    // kryptografisch ueber GUID->Session->Playername belegt werden kann.
    // Deshalb niemals still History loeschen und DONE melden: fail closed.
    const unresolvedApproved = await prisma.whitelistRequest.findFirst({
      where: { guildId, requesterDiscordId: discordId, status: 'APPROVED' },
      select: { id: true },
    });
    if (unresolvedApproved) {
      throw new Error('Leave-Whitelist: APPROVED Whitelist-Request ohne verifizierbare Link-Zuordnung; manuelle Klaerung erforderlich.');
    }

    // Restliche PENDING/DENIED/CANCELLED Request-History ist rein lokal und
    // darf jetzt guildweit entfernt werden.
    const deleted = await prisma.whitelistRequest.deleteMany({
      where: { guildId, requesterDiscordId: discordId },
    });
    total.requestsDeleted += deleted.count;
  }

  return total;
}
