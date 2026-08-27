import prisma from '../../database/prisma';
import { config } from '../../config';
import { identityHash } from '../linking/identity';
import { hasOpenLeaveCleanupRequest } from '../moderation/leaveCleanupGuard';
import {
  withNitradoOutboxConnectionLock,
  withNitradoOutboxSubjectLock,
  type NitradoOutboxClient,
  type NitradoOutboxTxClient,
} from '../nitrado/outboxLock';
import {
  WHITELIST_REMOVE_SAFETY_INTENT,
  isAuthorizedWhitelistRemovePayload,
} from './whitelistJobSafety';

export type WhitelistJobOperation = 'WHITELIST_ADD' | 'WHITELIST_REMOVE';
export type WhitelistOutboxClient = NitradoOutboxClient;

export interface WhitelistOutboxScope {
  guildId: string;
  nitradoConnId: string;
}

export class WhitelistAddBlockedByLeaveCleanupError extends Error {
  readonly status = 409;
  readonly code = 'LEAVE_CLEANUP_PENDING';

  constructor() {
    super('Dieser Spieler kann erst wieder auf die Whitelist gesetzt werden, wenn sein vorheriger Austritts-Cleanup erfolgreich abgeschlossen ist.');
    this.name = 'WhitelistAddBlockedByLeaveCleanupError';
  }
}

function norm(value: string): string {
  return value.trim().toLocaleLowerCase('en-US');
}

function payloadGameId(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const gameId = (value as Record<string, unknown>).gameId;
  return typeof gameId === 'string' && gameId.trim() ? gameId.trim() : null;
}

function sameGameId(payload: unknown, normalizedGameId: string): boolean {
  const gameId = payloadGameId(payload);
  return gameId !== null && norm(gameId) === normalizedGameId;
}

function jobPayload(operation: WhitelistJobOperation, gameId: string): Record<string, string> {
  if (operation === 'WHITELIST_REMOVE') {
    return { gameId, removeSafetyIntent: WHITELIST_REMOVE_SAFETY_INTENT };
  }
  return { gameId };
}

/**
 * Ein alter Leave-Cleanup darf nach bereits abgeschlossenem WHITELIST-Step
 * nicht durch einen Rejoin + erneutes ADD unterlaufen werden. Der Guard sitzt
 * zentral vor JEDEM WHITELIST_ADD-Outbox-Intent, damit Dashboard, Buttons,
 * Commands und interne Caller dieselbe Invariante teilen.
 *
 * Die Zuordnung bleibt fail-closed gegen Fremdloeschungen: Ein Name blockiert
 * nur dann, wenn vorhandene Session-Evidenz -> GUID-HMAC -> VERIFIED Link exakt
 * auf einen Discord-User mit offenem Cleanup in derselben Guild/Connection zeigt.
 */
async function assertNoOpenLeaveCleanupForWhitelistAdd(
  scope: WhitelistOutboxScope,
  gameId: string,
): Promise<void> {
  const sessions = await prisma.playerSession.findMany({
    where: {
      guildId: scope.guildId,
      nitradoConnId: scope.nitradoConnId,
      playerName: { equals: gameId, mode: 'insensitive' },
    },
    select: { gameId: true },
    distinct: ['gameId'],
  });
  if (sessions.length === 0) return;

  const hashes = Array.from(new Set(
    sessions
      .map(session => session.gameId?.trim())
      .filter((value): value is string => Boolean(value))
      .map(rawGameId => identityHash(rawGameId, config.security.encryptionKey)),
  ));
  if (hashes.length === 0) return;

  const links = await prisma.gameIdentityLink.findMany({
    where: {
      guildId: scope.guildId,
      nitradoConnId: scope.nitradoConnId,
      status: 'VERIFIED',
      identityHash: { in: hashes },
    },
    select: { userDiscordId: true },
  });

  for (const discordId of new Set(links.map(link => link.userDiscordId))) {
    if (await hasOpenLeaveCleanupRequest(scope.guildId, discordId)) {
      throw new WhitelistAddBlockedByLeaveCleanupError();
    }
  }
}

async function ensureWhitelistJobInLock(
  tx: NitradoOutboxTxClient,
  scope: WhitelistOutboxScope,
  operation: WhitelistJobOperation,
  gameId: string,
  normalizedGameId: string,
): Promise<boolean> {
  const existing = await tx.nitradoJob.findMany({
    where: {
      guildId: scope.guildId,
      nitradoConnId: scope.nitradoConnId,
      operation,
      status: { in: ['PENDING', 'RUNNING'] },
    },
    select: { payload: true },
  });
  const matching = existing.filter(job => sameGameId(job.payload, normalizedGameId));
  if (operation === 'WHITELIST_ADD' && matching.length > 0) return false;
  if (operation === 'WHITELIST_REMOVE' && matching.some(job => isAuthorizedWhitelistRemovePayload(job.payload))) {
    return false;
  }

  // Ein aktiver Legacy-REMOVE ohne Safety-Marker darf einen neuen, autorisierten
  // Remove nicht deduplizieren. Beide duerfen kurz koexistieren: Der alte Job
  // wird bei UNTRACKED fail-closed zum No-op, der markierte Job traegt die neue
  // explizite Outbox-Autorisierung.
  await tx.nitradoJob.create({
    data: {
      guildId: scope.guildId,
      nitradoConnId: scope.nitradoConnId,
      operation,
      payload: jobPayload(operation, gameId),
    },
  });
  return true;
}

/**
 * Atomare Deduplizierung pro Guild + Nitrado-Connection + Operation + Name.
 * DONE/DEAD blockieren absichtlich keinen neuen Job; nur ein bereits aktiver
 * PENDING/RUNNING-Intent verhindert ein Duplikat. Nitrado-1U legt davor eine
 * Connection-weite xact-Barriere, damit ein paralleler Service-Rebind entweder
 * diesen Enqueue vollstaendig vor seinem Cleanup sieht oder der Enqueue erst
 * nach dem abgeschlossenen Rebind committen kann.
 *
 * WHITELIST_REMOVE wird seit dem Produktions-Hotfix immer mit einem expliziten
 * Safety-Intent markiert. Dadurch koennen Legacy-/Fremdjobs ohne Marker bei
 * fehlender lokaler Zeile im Worker fail-closed neutralisiert werden.
 */
export async function enqueueWhitelistJob(
  client: WhitelistOutboxClient,
  scope: WhitelistOutboxScope,
  operation: WhitelistJobOperation,
  rawGameId: string,
): Promise<boolean> {
  const gameId = rawGameId.trim();
  if (!gameId) throw new Error('Whitelist-Outbox: leerer Gameserver-Identifier.');
  if (operation === 'WHITELIST_ADD') {
    await assertNoOpenLeaveCleanupForWhitelistAdd(scope, gameId);
  }
  const normalizedGameId = norm(gameId);
  const lockSubject = [
    'nitrado-whitelist-outbox:v1',
    scope.guildId,
    scope.nitradoConnId,
    operation,
    normalizedGameId,
  ].join(':');

  return withNitradoOutboxConnectionLock(client, scope, tx =>
    withNitradoOutboxSubjectLock(tx, lockSubject, lockedTx =>
      ensureWhitelistJobInLock(lockedTx, scope, operation, gameId, normalizedGameId),
    ),
  );
}

export async function enqueueWhitelistAdd(
  client: WhitelistOutboxClient,
  scope: WhitelistOutboxScope,
  gameId: string,
): Promise<boolean> {
  return enqueueWhitelistJob(client, scope, 'WHITELIST_ADD', gameId);
}

export async function enqueueWhitelistRemove(
  client: WhitelistOutboxClient,
  scope: WhitelistOutboxScope,
  gameId: string,
): Promise<boolean> {
  return enqueueWhitelistJob(client, scope, 'WHITELIST_REMOVE', gameId);
}
