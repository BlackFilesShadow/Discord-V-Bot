/**
 * Privacy-sichere Nitrado-Outbox fuer Server-Banns.
 *
 * ADD braucht den echten Gameserver-Identifier. Er wird vor Persistenz mit
 * AES-256-GCM verschluesselt. Nitrado-1W persistiert dieselbe verschluesselte
 * Identitaet zusaetzlich banId-gebunden fuer spaetere DB<->Nitrado-
 * Reconciliation; Klartext wird weiterhin niemals gespeichert.
 * REMOVE braucht keinen Klartext: der Worker liest die Nitrado-Banlist live und
 * findet den passenden Identifier per HMAC gegen ServerBanEntry.identityHash.
 *
 * Nitrado-1A: Dedupe ist ueber einen DB-Advisory-xact-Lock pro
 * Guild+Connection+Operation+Ban-ID cross-process atomar. Damit koennen zwei
 * Bot-Instanzen nicht gleichzeitig denselben aktiven Ban-Outbox-Intent anlegen.
 *
 * Nitrado-1J/1W: automatische ADD-/REMOVE-Reconciler respektieren zusaetzlich
 * einen Connection-weiten Recent-DEAD-Cooldown. DEAD Server-Ban-Jobs scrubben
 * ihre Payload absichtlich; der Cooldown darf deshalb nicht von der Ban-ID in
 * einer historischen Payload abhaengen. Explizite Bedieneraktionen bleiben
 * ohne diesen Auto-Cooldown retrybar.
 *
 * Nitrado-1U: Jeder Ban-Enqueue nimmt zusaetzlich eine Connection-weite
 * DB-xact-Barriere. Service-Rebind und Outbox-Neuanlage koennen dadurch nicht
 * aneinander vorbeicommitten.
 */

import { encrypt } from '../../utils/security';
import {
  withNitradoOutboxConnectionLock,
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

export interface ServerBanAddEnqueueOptions {
  /** Nur fuer automatische Reconciliation setzen; Bediener-ADDs bleiben direkt retrybar. */
  recentDeadCooldownMs?: number;
  /** Test-/Scheduler-Zeitpunkt; Produktion verwendet standardmaessig jetzt. */
  now?: Date;
}

export interface ServerBanRemoveEnqueueOptions {
  /** Nur fuer eine explizite Bedieneraktion wie /server-unban verwenden. */
  bypassRecentDeadCooldown?: boolean;
  /** Test-/Scheduler-Zeitpunkt; Produktion verwendet standardmaessig jetzt. */
  now?: Date;
}

export type BanOutboxClient = NitradoOutboxClient;

export const SERVER_BAN_ADD_AUTO_DEAD_COOLDOWN_MS = 60 * 60 * 1000;
export const SERVER_BAN_REMOVE_AUTO_DEAD_COOLDOWN_MS = 60 * 60 * 1000;

interface BanRemoteIdentityTxClient {
  serverBanRemoteIdentity: {
    upsert(args: {
      where: { banId: string };
      create: { banId: string; identifierEnc: string };
      update: { identifierEnc: string };
    }): Promise<unknown>;
  };
}

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
  // Nitrado-1W: ADD-Identifier wird innerhalb derselben Connection+Subject-
  // Transaktion dauerhaft verschluesselt gespeichert. Das passiert bewusst vor
  // der aktiven Job-Dedupe: auch ein bereits vorhandener Intent darf die
  // kanonische Reconciliation-Identitaet aktualisieren/backfillen.
  if (operation === 'SERVER_BAN_ADD' && payload.encryptedIdentifier) {
    const identityTx = tx as unknown as BanRemoteIdentityTxClient;
    await identityTx.serverBanRemoteIdentity.upsert({
      where: { banId: payload.banId },
      create: { banId: payload.banId, identifierEnc: payload.encryptedIdentifier },
      update: { identifierEnc: payload.encryptedIdentifier },
    });
  }

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

  return withNitradoOutboxConnectionLock(client, scope, tx =>
    withNitradoOutboxSubjectLock(tx, lockSubject, lockedTx =>
      ensureJobInLock(lockedTx, scope, operation, payload, options),
    ),
  );
}

/** Queued Remote-Ban; Klartext-Identifier wird nie in der Job-Payload gespeichert. */
export async function enqueueServerBanAdd(
  client: BanOutboxClient,
  scope: BanOutboxScope,
  banId: string,
  rawIdentifier: string,
  encryptionKey: string,
  options: ServerBanAddEnqueueOptions = {},
): Promise<boolean> {
  const identifier = rawIdentifier.trim();
  if (!identifier) throw new Error('Leerer Server-Ban-Identifier');
  return ensureJob(
    client,
    scope,
    'SERVER_BAN_ADD',
    {
      banId,
      encryptedIdentifier: encrypt(identifier, encryptionKey),
    },
    {
      recentDeadCooldownMs: Math.max(0, options.recentDeadCooldownMs ?? 0),
      now: options.now,
    },
  );
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
