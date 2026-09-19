/**
 * Privacy-sichere Nitrado-Outbox fuer Server-Banns.
 *
 * ADD braucht die interne Ban-Identitaet und optional eine davon abweichende
 * Remote-Identitaet. Beide werden vor Persistenz mit AES-256-GCM verschluesselt.
 * Normalfall/manueller Ban: beide sind identisch. Radar-Auto-Ban: die interne
 * Identitaet bleibt die eindeutige DayZ-GUID, waehrend Nitrado den sichtbaren
 * Spielernamen in settings.general.bans erhaelt.
 *
 * Nitrado-1W persistiert die Remote-Identitaet banId-gebunden fuer spaetere
 * DB<->Nitrado-Reconciliation. Falls Subject und Remote abweichen, wird die
 * interne Subject-Identitaet separat verschluesselt mitpersistiert. Klartext
 * wird weiterhin niemals gespeichert.
 * REMOVE braucht keinen Klartext in der Job-Payload: der Worker loest die
 * persistierte Remote-Identitaet zur Laufzeit wieder auf.
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
 *
 * Radar-Auto-Bans tragen zusaetzlich `radarAutoBan: true`. Dieses Flag wird
 * ausschliesslich aus einem tatsaechlich vorhandenen, nicht invalidierten
 * RadarAutoBanBanFence abgeleitet. Es ist nur Herkunftsmarker; Autoritaet bleibt
 * der Fence selbst, der vor Remote-Durchsetzung erneut geprueft wird.
 */

import { encrypt } from '../../utils/security';
import {
  withNitradoOutboxConnectionLock,
  withNitradoOutboxSubjectLock,
  type NitradoOutboxClient,
  type NitradoOutboxTxClient,
} from '../nitrado/outboxLock';
import { markWhitelistRemoveIntent } from '../whitelist/whitelistOutbox';

export type ServerBanJobOperation = 'SERVER_BAN_ADD' | 'SERVER_BAN_REMOVE';

export interface ServerBanJobPayload {
  banId: string;
  /** Verschluesselte interne Policy-/Subject-Identitaet (bei Radar die GUID). */
  encryptedIdentifier?: string;
  /** Optional abweichende Remote-Identitaet fuer Nitrados Banliste (bei Radar der Spielername). */
  encryptedRemoteIdentifier?: string;
  radarAutoBan?: true;
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
  /**
   * Abweichender sichtbarer Identifier fuer die Nitrado-Banliste.
   * Darf ausschliesslich bei einem aktiv gefenceten Radar-Auto-Ban verwendet
   * werden; die interne HMAC-/Whitelist-Identitaet bleibt `rawIdentifier`.
   */
  remoteIdentifier?: string;
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
      create: { banId: string; identifierEnc: string; subjectIdentifierEnc: string | null };
      update: { identifierEnc: string; subjectIdentifierEnc: string | null };
    }): Promise<unknown>;
  };
  radarAutoBanBanFence?: {
    findFirst(args: unknown): Promise<{ banId: string } | null>;
  };
}

interface EnsureBanJobOptions {
  recentDeadCooldownMs?: number;
  now?: Date;
  /** Nur zur Laufzeit; wird nie in NitradoJob.payload persistiert. */
  whitelistIdentifier?: string;
}

function asPayload(value: unknown): ServerBanJobPayload | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.banId !== 'string' || !v.banId.trim()) return null;
  if (v.encryptedIdentifier !== undefined && typeof v.encryptedIdentifier !== 'string') return null;
  if (v.encryptedRemoteIdentifier !== undefined && typeof v.encryptedRemoteIdentifier !== 'string') return null;
  if (v.radarAutoBan !== undefined && v.radarAutoBan !== true) return null;
  return {
    banId: v.banId,
    ...(typeof v.encryptedIdentifier === 'string' ? { encryptedIdentifier: v.encryptedIdentifier } : {}),
    ...(typeof v.encryptedRemoteIdentifier === 'string'
      ? { encryptedRemoteIdentifier: v.encryptedRemoteIdentifier }
      : {}),
    ...(v.radarAutoBan === true ? { radarAutoBan: true as const } : {}),
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
  options: EnsureBanJobOptions = {},
): Promise<boolean> {
  if (operation === 'SERVER_BAN_ADD' && options.whitelistIdentifier) {
    // Ein Bann bedeutet immer auch: derselbe Spieler darf lokal nicht weiter
    // als SYNCED-Whitelist-Wahrheit stehen. Bei Radar ist dies bewusst die GUID
    // und NICHT der sichtbare Remote-Banname.
    await markWhitelistRemoveIntent(tx, scope, options.whitelistIdentifier);
  }

  if (operation === 'SERVER_BAN_ADD' && payload.encryptedIdentifier) {
    const identityTx = tx as unknown as BanRemoteIdentityTxClient;
    const remoteIdentifierEnc = payload.encryptedRemoteIdentifier ?? payload.encryptedIdentifier;
    const subjectIdentifierEnc = payload.encryptedRemoteIdentifier
      ? payload.encryptedIdentifier
      : null;
    await identityTx.serverBanRemoteIdentity.upsert({
      where: { banId: payload.banId },
      create: {
        banId: payload.banId,
        identifierEnc: remoteIdentifierEnc,
        subjectIdentifierEnc,
      },
      update: {
        identifierEnc: remoteIdentifierEnc,
        subjectIdentifierEnc,
      },
    });
  }

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
  options: EnsureBanJobOptions = {},
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

async function hasActiveRadarFence(
  client: BanOutboxClient,
  scope: BanOutboxScope,
  banId: string,
): Promise<boolean> {
  const db = client as unknown as BanRemoteIdentityTxClient;
  // Bestehende Minimal-Adapter/Unit-Test-Clients koennen dieses additive Modell
  // nicht besitzen. Ein produktiver Radar-Auto-Ban kann ohne vorherigen
  // Fence-Upsert ohnehin nicht entstehen.
  if (!db.radarAutoBanBanFence) return false;
  const fence = await db.radarAutoBanBanFence.findFirst({
    where: {
      banId,
      guildId: scope.guildId,
      nitradoConnId: scope.nitradoConnId,
      invalidatedAt: null,
    },
    select: { banId: true },
  });
  return fence !== null;
}

/**
 * Queued Remote-Ban. `rawIdentifier` ist immer die interne Ban-/Whitelist-
 * Identitaet. Nur ein aktiv gefenceter Radar-Auto-Ban darf ueber
 * `options.remoteIdentifier` einen abweichenden sichtbaren Nitrado-Banname
 * mitgeben. Klartext-Identifier werden nie in der Job-Payload gespeichert.
 */
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

  const radarAutoBan = await hasActiveRadarFence(client, scope, banId);
  const requestedRemoteIdentifier = options.remoteIdentifier?.trim() ?? '';
  if (requestedRemoteIdentifier && !radarAutoBan) {
    throw new Error('Abweichender Remote-Ban-Identifier ist nur fuer gefencete Radar-Auto-Bans erlaubt');
  }
  const remoteIdentifier = requestedRemoteIdentifier || identifier;
  if (!remoteIdentifier) throw new Error('Leerer Remote-Ban-Identifier');

  const differsFromSubject = remoteIdentifier.toLocaleLowerCase('en-US')
    !== identifier.toLocaleLowerCase('en-US');

  return ensureJob(
    client,
    scope,
    'SERVER_BAN_ADD',
    {
      banId,
      encryptedIdentifier: encrypt(identifier, encryptionKey),
      ...(differsFromSubject
        ? { encryptedRemoteIdentifier: encrypt(remoteIdentifier, encryptionKey) }
        : {}),
      ...(radarAutoBan ? { radarAutoBan: true as const } : {}),
    },
    {
      recentDeadCooldownMs: Math.max(0, options.recentDeadCooldownMs ?? 0),
      now: options.now,
      whitelistIdentifier: identifier,
    },
  );
}

/**
 * Queued Remote-Unban; Identifier wird spaeter aus der persistenten
 * ServerBanRemoteIdentity und der Remote-Banlist aufgeloest. Automatische
 * Scheduler respektieren standardmaessig einen Connection-weiten
 * Recent-DEAD-Cooldown, damit permanente Remote-/Konfigurationsfehler keinen
 * endlosen Job-Neuanlage-Sturm erzeugen. Explizite Bedieneraktionen koennen den
 * Cooldown mit `bypassRecentDeadCooldown` bewusst umgehen.
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
