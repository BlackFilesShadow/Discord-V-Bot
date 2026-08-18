import {
  withNitradoOutboxSubjectLock,
  type NitradoOutboxClient,
  type NitradoOutboxTxClient,
} from '../nitrado/outboxLock';

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
    take: 500,
  });
  if (existing.some(job => sameGameId(job.payload, normalizedGameId))) return false;

  await tx.nitradoJob.create({
    data: {
      guildId: scope.guildId,
      nitradoConnId: scope.nitradoConnId,
      operation,
      payload: { gameId },
    },
  });
  return true;
}

/**
 * Atomare Deduplizierung pro Guild + Nitrado-Connection + Operation + Name.
 * DONE/DEAD blockieren absichtlich keinen neuen Job; nur ein bereits aktiver
 * PENDING/RUNNING-Intent verhindert ein Duplikat.
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

  return withNitradoOutboxSubjectLock(client, lockSubject, tx =>
    ensureWhitelistJobInLock(tx, scope, operation, gameId, normalizedGameId),
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
