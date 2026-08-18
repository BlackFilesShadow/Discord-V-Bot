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
 *
 * Nitrado-1J: automatische SERVER_BAN_REMOVE-Reconciler respektieren zusaetzlich
 * einen Connection-weiten Recent-DEAD-Cooldown. DEAD Server-Ban-Jobs scrubben
 * ihre Payload absichtlich; der Cooldown darf deshalb nicht von der Ban-ID in
 * einer historischen Payload abhaengen. Der Check liegt unter demselben
 * Subject-Lock wie Dedupe+Create. Explizite Bedieneraktionen duerfen den
 * Cooldown bewusst umgehen.
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

export interface ServerBanRemoveEnqueueOptions {
  /** Nur fuer eine explizite Bedieneraktion wie /server-unban verwenden. */
  bypassRecentDeadCooldown?: boolean;
  /** Test-/Scheduler-Zeitpunkt; Produktion verwendet standardmaessig jetzt. */
  now?: Date;
}

export type BanOutboxClient = NitradoOutboxClient;

export const SERVER_BAN_REMOVE_AUTO_DEAD_COOLDOWN_MS = 60 * 60 * 1000;

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
  options: { recentDeadCooldownMs?: number; now?: Date } = {},
): Promise<boolean> {
  // Aktive Jobs blockieren immer. Ohne `take`-Fenster werden auch vorhandene
  // Legacy-Outboxen vollstaendig in die atomare Deduplizierung einbezogen.
  const existing = await tx.nitradoJob.findMany({
    where: {
      guildId: scope.guildId,
      nitradoConnId: scope.nitradoConnId,
      operation,
      status: { in: ['PENDING', 'RUNNING'] },
    },
    select: { payload: true },
  });
  if (existing.some(job => asPayload(job.payload)?.banId === payload.banId)) return false;

  const recentDeadCooldownMs = options.recentDeadCooldownMs ?? 0;
  if (recentDeadCooldownMs > 0) {
    const now = options.now ?? new Date();
    const recentDead = await tx.nitradoJob.findMany({
      where: {
        guildId: scope.guildId,
        nitradoConnId: scope.nitradoConnId,
        operation,
        status: 'DEAD',
        updatedAt: { gte: new Date(now.getTime() - recentDeadCooldownMs) },
      },
      select: { payload: true },
      take: 1,
    });
    if (recentDead.length > 0) return false;
  }

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
  options: { recentDeadCooldownMs?: number; now?: Date } = {},
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
    ensureJobInLock(tx, scope, operation, payload, options),
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

/**
 * Queued Remote-Unban; Identifier wird spaeter aus der Remote-Banlist
 * aufgeloest. Automatische Scheduler respektieren standardmaessig einen
 * Connection-weiten Recent-DEAD-Cooldown, damit permanente Remote-/
 * Konfigurationsfehler keinen endlosen Job-Neuanlage-Sturm erzeugen.
 * Explizite Bedieneraktionen koennen den Cooldown mit
 * `bypassRecentDeadCooldown` bewusst umgehen.
 */
export async function enqueueServerBanRemove(
  client: BanOutboxClient,
  scope: BanOutboxScope,
  banId: string,
  options: ServerBanRemoveEnqueueOptions = {},
): Promise<boolean> {
  return ensureJob(
    client,
    scope,
    'SERVER_BAN_REMOVE',
    { banId },
    {
      recentDeadCooldownMs: options.bypassRecentDeadCooldown
        ? 0
        : SERVER_BAN_REMOVE_AUTO_DEAD_COOLDOWN_MS,
      now: options.now,
    },
  );
}
