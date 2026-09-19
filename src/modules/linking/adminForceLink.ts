import { randomUUID } from 'node:crypto';
import prisma from '../../database/prisma';
import { assertNoOpenLeaveCleanupRequest, LeaveCleanupPendingError } from '../moderation/leaveCleanupGuard';
import { leaveCleanupJobKey, leaveCleanupReceiptFingerprint } from '../moderation/leaveCleanupSaga';
import { identityHash } from './identity';
import {
  isValidPlayerName,
  resolvePlayerIdentityByName,
  unlinkUser,
  type LinkClient,
  type LinkScope,
  type SessionLinkClient,
} from './linkService';

interface RawDb {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

interface ForcedLinkRow {
  userDiscordId: string;
  identityHash: string | null;
  status: 'PENDING' | 'VERIFIED' | 'UNLINKED';
  forcedPlayerName: string | null;
  verifiedAt: Date | null;
}

export type AdminForceLinkResult =
  | {
      ok: true;
      alreadyLinked: boolean;
      playerName: string;
      gameId: string | null;
      playedSeconds: number;
      pendingIdentityResolution: boolean;
      newIdentityBinding: boolean;
    }
  | {
      ok: false;
      reason: 'PLAYER_NAME_TAKEN' | 'IDENTITY_TAKEN' | 'USER_ALREADY_LINKED' | 'INVALID_PLAYER_NAME';
      playerName: string;
    };

export interface ReconciledAdminForceLink {
  userDiscordId: string;
  playerName: string;
  gameId: string;
  newIdentityBinding: boolean;
}

function rawDb(client: unknown = prisma): RawDb {
  return client as RawDb;
}

function normalizePlayerName(value: string): string {
  return value.trim();
}

async function observedNameHashes(raw: RawDb, guildId: string, nitradoConnId: string, playerName: string, secret: string): Promise<string[]> {
  const sessions = await raw.$queryRawUnsafe<Array<{ gameId: string }>>(
    'SELECT DISTINCT "gameId" FROM "PlayerSession" WHERE "guildId"=$1 AND "nitradoConnId"=$2 AND "playerName"=$3 LIMIT 5000',
    guildId,
    nitradoConnId,
    playerName,
  );
  return [...new Set(sessions.map(row => identityHash(row.gameId, secret)))];
}

async function persistAdminForcedLink(args: {
  scope: LinkScope;
  userDiscordId: string;
  playerName: string;
  gameId: string | null;
  secret: string;
  now: Date;
}): Promise<AdminForceLinkResult> {
  const hash = args.gameId ? identityHash(args.gameId, args.secret) : null;

  return prisma.$transaction(async tx => {
    const raw = rawDb(tx);
    const leaveKey = leaveCleanupJobKey(args.scope.guildId, args.userDiscordId);
    const nameKey = `admin-force-link-name:v1:${args.scope.guildId}:${args.scope.nitradoConnId}:${args.playerName}`;
    await raw.$queryRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', leaveKey);
    await raw.$queryRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', nameKey);

    const openLeave = await tx.dataDeletionRequest.findFirst({
      where: {
        userId: leaveKey,
        requestType: 'PARTIAL_DELETION',
        status: { in: ['PENDING', 'IN_PROGRESS', 'FAILED'] },
      },
      select: { id: true },
    });
    if (openLeave) throw new LeaveCleanupPendingError();

    const fingerprint = leaveCleanupReceiptFingerprint(args.scope.guildId, args.userDiscordId, args.secret);
    const completedLeave = await tx.dataDeletionRequest.findFirst({
      where: {
        userId: fingerprint,
        discordId: fingerprint,
        requestType: 'PARTIAL_DELETION',
        status: 'COMPLETED',
      },
      select: { id: true, completedAt: true },
      orderBy: { completedAt: 'desc' },
    });
    if (completedLeave && (!completedLeave.completedAt || args.now <= completedLeave.completedAt)) {
      throw new LeaveCleanupPendingError();
    }

    const currentRows = await raw.$queryRawUnsafe<ForcedLinkRow[]>(
      'SELECT "userDiscordId", "identityHash", "status"::text AS status, "forcedPlayerName", "verifiedAt" FROM "GameIdentityLink" WHERE "guildId"=$1 AND "nitradoConnId"=$2 AND "userDiscordId"=$3 LIMIT 1 FOR UPDATE',
      args.scope.guildId,
      args.scope.nitradoConnId,
      args.userDiscordId,
    );
    const current = currentRows[0] ?? null;
    if (current?.status === 'VERIFIED') {
      if (current.forcedPlayerName !== args.playerName) {
        return { ok: false, reason: 'USER_ALREADY_LINKED', playerName: args.playerName } as const;
      }
      if (hash && current.identityHash && current.identityHash !== hash) {
        return { ok: false, reason: 'USER_ALREADY_LINKED', playerName: args.playerName } as const;
      }
    }

    const forcedOwner = await raw.$queryRawUnsafe<Array<{ userDiscordId: string }>>(
      'SELECT "userDiscordId" FROM "GameIdentityLink" WHERE "guildId"=$1 AND "nitradoConnId"=$2 AND "forcedPlayerName"=$3 AND "status"=\'VERIFIED\'::"GameIdentityStatus" AND "userDiscordId"<>$4 LIMIT 1 FOR UPDATE',
      args.scope.guildId,
      args.scope.nitradoConnId,
      args.playerName,
      args.userDiscordId,
    );
    if (forcedOwner[0]) return { ok: false, reason: 'PLAYER_NAME_TAKEN', playerName: args.playerName } as const;

    const nameHashes = await observedNameHashes(raw, args.scope.guildId, args.scope.nitradoConnId, args.playerName, args.secret);
    for (const observedHash of nameHashes) {
      const owner = await raw.$queryRawUnsafe<Array<{ userDiscordId: string }>>(
        'SELECT "userDiscordId" FROM "GameIdentityLink" WHERE "guildId"=$1 AND "nitradoConnId"=$2 AND "identityHash"=$3 AND "status"=\'VERIFIED\'::"GameIdentityStatus" AND "userDiscordId"<>$4 LIMIT 1 FOR UPDATE',
        args.scope.guildId,
        args.scope.nitradoConnId,
        observedHash,
        args.userDiscordId,
      );
      if (owner[0]) return { ok: false, reason: 'PLAYER_NAME_TAKEN', playerName: args.playerName } as const;
    }

    if (hash) {
      const identityOwner = await raw.$queryRawUnsafe<Array<{ userDiscordId: string }>>(
        'SELECT "userDiscordId" FROM "GameIdentityLink" WHERE "guildId"=$1 AND "nitradoConnId"=$2 AND "identityHash"=$3 AND "status"=\'VERIFIED\'::"GameIdentityStatus" AND "userDiscordId"<>$4 LIMIT 1 FOR UPDATE',
        args.scope.guildId,
        args.scope.nitradoConnId,
        hash,
        args.userDiscordId,
      );
      if (identityOwner[0]) return { ok: false, reason: 'IDENTITY_TAKEN', playerName: args.playerName } as const;
    }

    const wasResolved = Boolean(current?.status === 'VERIFIED' && current.identityHash);
    const alreadyLinked = Boolean(
      current?.status === 'VERIFIED'
      && current.forcedPlayerName === args.playerName
      && ((!hash && !current.identityHash) || (hash && current.identityHash === hash)),
    );

    if (!alreadyLinked) {
      if (current) {
        const changed = await raw.$executeRawUnsafe(
          'UPDATE "GameIdentityLink" SET "identityHash"=$4, "status"=\'VERIFIED\'::"GameIdentityStatus", "forcedPlayerName"=$5, "verifiedAt"=$6, "unlinkedAt"=NULL, "challengeCode"=NULL, "challengeExpiresAt"=NULL, "updatedAt"=CURRENT_TIMESTAMP WHERE "guildId"=$1 AND "nitradoConnId"=$2 AND "userDiscordId"=$3',
          args.scope.guildId,
          args.scope.nitradoConnId,
          args.userDiscordId,
          hash,
          args.playerName,
          args.now,
        );
        if (changed !== 1) throw new Error('Force-Link konnte nicht aktualisiert werden.');
      } else {
        const changed = await raw.$executeRawUnsafe(
          'INSERT INTO "GameIdentityLink" ("id", "guildId", "nitradoConnId", "userDiscordId", "identityHash", "status", "forcedPlayerName", "challengeCode", "challengeExpiresAt", "verifiedAt", "unlinkedAt", "createdAt", "updatedAt") VALUES ($1,$2,$3,$4,$5,\'VERIFIED\'::"GameIdentityStatus",$6,NULL,NULL,$7,NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)',
          randomUUID(),
          args.scope.guildId,
          args.scope.nitradoConnId,
          args.userDiscordId,
          hash,
          args.playerName,
          args.now,
        );
        if (changed !== 1) throw new Error('Force-Link konnte nicht erstellt werden.');
      }
    }

    return {
      ok: true,
      alreadyLinked,
      playerName: args.playerName,
      gameId: args.gameId,
      playedSeconds: 0,
      pendingIdentityResolution: !hash,
      newIdentityBinding: Boolean(hash && !wasResolved),
    } as const;
  });
}

/**
 * Admin-Force-Link folgt derselben eindeutigen ADM-/Session-Aufloesung wie der
 * normale Link. Der einzige Override ist die 5-Minuten-Spielzeitsperre. Dadurch
 * wird kein neuer name-only Link mehr erzeugt; bestehende historische
 * Provisional-Links werden bei einem eindeutigen Session-Treffer normalisiert.
 */
export async function forceAdminLinkByPlayerName(args: {
  scope: LinkScope;
  userDiscordId: string;
  playerName: string;
  secret: string;
  now?: Date;
}): Promise<AdminForceLinkResult> {
  const playerName = normalizePlayerName(args.playerName);
  if (!isValidPlayerName(playerName)) return { ok: false, reason: 'INVALID_PLAYER_NAME', playerName };
  const now = args.now ?? new Date();
  await assertNoOpenLeaveCleanupRequest(args.scope.guildId, args.userDiscordId);
  const resolved = await resolvePlayerIdentityByName(
    prisma as unknown as SessionLinkClient,
    args.scope,
    playerName,
    now,
  );
  if (!resolved || resolved === 'AMBIGUOUS') {
    return { ok: false, reason: 'INVALID_PLAYER_NAME', playerName };
  }
  const result = await persistAdminForcedLink({
    scope: args.scope,
    userDiscordId: args.userDiscordId,
    playerName,
    gameId: resolved.gameId,
    secret: args.secret,
    now,
  });
  if (result.ok) result.playedSeconds = resolved.playedSeconds;
  return result;
}

/**
 * Wiederholt sichere Aufloesung fuer historische Admin-Force-Links eines Servers.
 * Bereits gebundene Links werden ebenfalls zurueckgegeben, damit ein nach dem
 * GUID-Commit fehlgeschlagener Economy-Hook im naechsten Cronlauf idempotent
 * repariert werden kann. Neue Force-Links werden nicht mehr provisional erzeugt.
 */
export async function reconcileAdminForcedLinks(args: {
  scope: LinkScope;
  secret: string;
  now?: Date;
}): Promise<ReconciledAdminForceLink[]> {
  const now = args.now ?? new Date();
  const rows = await rawDb().$queryRawUnsafe<Array<{ userDiscordId: string; forcedPlayerName: string }>>(
    'SELECT "userDiscordId", "forcedPlayerName" FROM "GameIdentityLink" WHERE "guildId"=$1 AND "nitradoConnId"=$2 AND "status"=\'VERIFIED\'::"GameIdentityStatus" AND "forcedPlayerName" IS NOT NULL ORDER BY "verifiedAt" ASC LIMIT 500',
    args.scope.guildId,
    args.scope.nitradoConnId,
  );
  const out: ReconciledAdminForceLink[] = [];
  for (const row of rows) {
    const resolved = await resolvePlayerIdentityByName(
      prisma as unknown as SessionLinkClient,
      args.scope,
      row.forcedPlayerName,
      now,
    );
    if (!resolved || resolved === 'AMBIGUOUS') continue;
    const result = await persistAdminForcedLink({
      scope: args.scope,
      userDiscordId: row.userDiscordId,
      playerName: row.forcedPlayerName,
      gameId: resolved.gameId,
      secret: args.secret,
      now,
    });
    if (!result.ok || !result.gameId) continue;
    out.push({
      userDiscordId: row.userDiscordId,
      playerName: row.forcedPlayerName,
      gameId: result.gameId,
      newIdentityBinding: result.newIdentityBinding,
    });
  }
  return out;
}

/**
 * Entfernt einen stehengebliebenen `forcedPlayerName` fuer genau diesen Discord-
 * User+Server. `forcedPlayerName` lebt ausserhalb des Prisma-Schemas (nur
 * Rohmigration, siehe 20260828214500) und wird deshalb vom normalen, typisierten
 * `unlinkUser`-Upsert/Update NICHT mitgeloescht. Ohne diesen expliziten Aufruf
 * ueberlebt ein alter Force-Link-Name eine ganz normale `/unlink` und taucht bei
 * einem spaeteren regulaeren `/link` (auf einen komplett anderen Spieler) wieder
 * als VERIFIED+forcedPlayerName auf. Das belegt dann faelschlich den
 * server-eindeutigen `GameIdentityLink_scope_forced_player_name_verified_key`-
 * Index und blockiert einen legitimen Force-Link dieses alten Namens auf einen
 * anderen Discord-Account mit PLAYER_NAME_TAKEN. Muss daher bei JEDER Trennung
 * aufgerufen werden, nicht nur bei Force-Unlink.
 */
export async function clearProvisionalForcedPlayerName(scope: LinkScope, userDiscordId: string): Promise<boolean> {
  const cleared = await rawDb().$executeRawUnsafe(
    'UPDATE "GameIdentityLink" SET "forcedPlayerName"=NULL, "updatedAt"=CURRENT_TIMESTAMP WHERE "guildId"=$1 AND "nitradoConnId"=$2 AND "userDiscordId"=$3 AND "forcedPlayerName" IS NOT NULL',
    scope.guildId,
    scope.nitradoConnId,
    userDiscordId,
  );
  return cleared > 0;
}

/** ForceUnlink kennt keine PlayerSession-Voraussetzung und entfernt auch den provisional Namen. */
export async function forceAdminUnlinkUser(scope: LinkScope, userDiscordId: string, now: Date = new Date()): Promise<boolean> {
  const unlinked = await unlinkUser(prisma as unknown as LinkClient, scope, userDiscordId, now);
  const cleared = await clearProvisionalForcedPlayerName(scope, userDiscordId);
  return unlinked || cleared;
}
