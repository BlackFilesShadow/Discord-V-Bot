/**
 * Privacy-sichere Nitrado-Outbox fuer Server-Banns.
 *
 * ADD braucht den echten Gameserver-Identifier. Er wird vor Persistenz mit
 * AES-256-GCM verschluesselt und nur bis zum Jobabschluss benoetigt.
 * REMOVE braucht keinen Klartext: der Worker liest die Nitrado-Banlist live und
 * findet den passenden Identifier per HMAC gegen ServerBanEntry.identityHash.
 *
 * Nitrado-1A: Dedupe ist ueber einen DB-Advisory-xact-Lock pro
 * Guild+Connection+Operation+Ban-ID cross-process atomar. Damit koennen zwei
 * Bot-Instanzen nicht gleichzeitig denselben aktiven Ban-Outbox-Intent anlegen.
 */

import { encrypt } from '../../utils/security';
import {
  withNitradoOutboxSubjectLock,
  type NitradoOutboxClient,
  type NitradoOutboxTxClient,
} from '../nitrado/outboxLock';

export type ServerBanJobOperation = 'SERVER_BAN_ADD' | 'SERVER_BAN_REMOVE';

export interface ServerBanJobPayload {
  banId: string;
  encryptedIdentifier?: string;
}

export interface BanOutboxScope {
  guildId: string;
  nitradoConnId: string;
}

export type BanOutboxClient = NitradoOutboxClient;

function asPayload(value: unknown): ServerBanJobPayload | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.banId !== 'string' || !v.banId.trim()) return null;
  if (v.encryptedIdentifier !== undefined && typeof v.encryptedIdentifier !== 'string') return null;
  return {
    banId: v.banId,
    ...(typeof v.encryptedIdentifier === 'string' ? { encryptedIdentifier: v.encryptedIdentifier } : {}),
  };
}

export function parseServerBanJobPayload(value: unknown): ServerBanJobPayload {
  const payload = asPayload(value);
  if (!payload) throw new Error('Ungueltige Server-Ban-Job-Payload');
  return payload;
}

async function ensureJobInLock(
  tx: NitradoOutboxTxClient,
  scope: BanOutboxScope,
  operation: ServerBanJobOperation,
  payload: ServerBanJobPayload,
): Promise<boolean> {
  // Nur aktive Jobs blockieren einen neuen Job. DONE/DEAD bleiben Historie und
  // duerfen einen spaeteren expliziten Retry/Reconcile nicht verhindern.
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
  if (existing.some(job => asPayload(job.payload)?.banId === payload.banId)) return false;

  await tx.nitradoJob.create({
    data: {
      guildId: scope.guildId,
      nitradoConnId: scope.nitradoConnId,
      operation,
      payload,
    },
  });
  return true;
}

async function ensureJob(
  client: BanOutboxClient,
  scope: BanOutboxScope,
  operation: ServerBanJobOperation,
  payload: ServerBanJobPayload,
): Promise<boolean> {
  const banId = payload.banId.trim();
  if (!banId) throw new Error('Leere Server-Ban-ID');
  const lockSubject = [
    'nitrado-ban-outbox:v1',
    scope.guildId,
    scope.nitradoConnId,
    operation,
    banId,
  ].join(':');

  return withNitradoOutboxSubjectLock(client, lockSubject, tx =>
    ensureJobInLock(tx, scope, operation, payload),
  );
}

/** Queued Remote-Ban; Klartext-Identifier wird nie in der Job-Payload gespeichert. */
export async function enqueueServerBanAdd(
  client: BanOutboxClient,
  scope: BanOutboxScope,
  banId: string,
  rawIdentifier: string,
  encryptionKey: string,
): Promise<boolean> {
  const identifier = rawIdentifier.trim();
  if (!identifier) throw new Error('Leerer Server-Ban-Identifier');
  return ensureJob(client, scope, 'SERVER_BAN_ADD', {
    banId,
    encryptedIdentifier: encrypt(identifier, encryptionKey),
  });
}

/** Queued Remote-Unban; Identifier wird spaeter aus der Remote-Banlist aufgeloest. */
export async function enqueueServerBanRemove(
  client: BanOutboxClient,
  scope: BanOutboxScope,
  banId: string,
): Promise<boolean> {
  return ensureJob(client, scope, 'SERVER_BAN_REMOVE', { banId });
}
