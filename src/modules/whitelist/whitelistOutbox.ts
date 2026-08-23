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
