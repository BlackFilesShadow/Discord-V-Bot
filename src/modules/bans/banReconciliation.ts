import prisma from '../../database/prisma';
import { config } from '../../config';
import { decrypt, encrypt } from '../../utils/security';
import { logger, logAudit } from '../../utils/logger';
import { NitradoClient, type NitradoBanlistEntry } from '../nitrado/nitradoClient';
import { tryAcquireNitradoConfigMutationLock } from '../nitrado/configMutationLock';
import { inspectRadarAutoBanFenceForRemoteAdd } from '../radar/banFence';
import { isBanActive } from './banRegistry';
import { matchesBanIdentifier } from './banTarget';
import {
  enqueueServerBanAdd,
  enqueueServerBanRemove,
  SERVER_BAN_ADD_AUTO_DEAD_COOLDOWN_MS,
  type BanOutboxClient,
} from './banOutbox';
import { clearNitradoDriftNotice, notifyNitradoBanDrift } from '../nitrado/driftDiscord';
import type { Client } from 'discord.js';

const RECONCILE_INTERVAL_MS = 60_000;
const REMOTE_ABSENCE_CONFIRM_DELAY_MS = 350;
const BAN_BATCH = 500;
let timer: NodeJS.Timeout | null = null;
let running = false;

interface BanReconcileConnection {
  id: string;
  guildId: string;
  encryptedToken: string;
  nitradoServerId: string | null;
}

interface BanRow {
  id: string;
  identityHash: string;
  active: boolean;
  expiresAt: Date | null;
  appliedRemotely: boolean;
}

interface StoredIdentityRow {
  identifierEnc: string;
  subjectIdentifierEnc: string | null;
}

type DecodedStoredIdentity =
  | { kind: 'VALID'; remoteIdentifier: string; subjectIdentifier: string }
  | { kind: 'MISSING' }
  | { kind: 'CORRUPT' }
  | { kind: 'MISMATCH' };

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .slice(0, 800);
}

function normIdentifier(value: string): string {
  return value.trim().toLocaleLowerCase('en-US');
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function mergeRemoteRows(first: NitradoBanlistEntry[], second: NitradoBanlistEntry[]): NitradoBanlistEntry[] {
  const byNorm = new Map<string, NitradoBanlistEntry>();
  for (const row of [...first, ...second]) {
    const normalized = normIdentifier(row.identifier);
    if (normalized && !byNorm.has(normalized)) byNorm.set(normalized, row);
  }
  return [...byNorm.values()];
}

/**
 * Entschluesselt die beiden bewusst getrennten Ban-Identitaeten:
 * - remoteIdentifier: exakter Wert in Nitrados settings.general.bans;
 * - subjectIdentifier: interne Policy-/Whitelist-Identitaet, deren HMAC im
 *   ServerBanEntry liegt (bei Radar die DayZ-GUID).
 *
 * Legacy-/manuelle Zeilen haben kein subjectIdentifierEnc; dort ist
 * identifierEnc weiterhin gleichzeitig Subject und Remote-Identifier.
 */
function decodeStoredIdentity(
  row: StoredIdentityRow | null,
  identityHash: string,
): DecodedStoredIdentity {
  if (!row) return { kind: 'MISSING' };
  try {
    const remoteIdentifier = decrypt(row.identifierEnc, config.security.encryptionKey).trim();
    const subjectIdentifier = decrypt(
      row.subjectIdentifierEnc ?? row.identifierEnc,
      config.security.encryptionKey,
    ).trim();
    if (!remoteIdentifier || !subjectIdentifier) return { kind: 'CORRUPT' };
    if (!matchesBanIdentifier(subjectIdentifier, identityHash, config.security.encryptionKey)) {
      return { kind: 'MISMATCH' };
    }
    return { kind: 'VALID', remoteIdentifier, subjectIdentifier };
  } catch {
    return { kind: 'CORRUPT' };
  }
}

function findRemoteIdentifier(
  remoteRows: NitradoBanlistEntry[],
  ban: Pick<BanRow, 'identityHash'>,
  storedIdentity: DecodedStoredIdentity,
): string | null {
  // Mit persistierter, kryptografisch validierter Identitaet ist der explizite
  // Remote-Identifier die kanonische Vergleichswahrheit. Das ist bei Radar der
  // Spielername, waehrend die HMAC weiterhin an der GUID haengt.
  if (storedIdentity.kind === 'VALID') {
    const target = normIdentifier(storedIdentity.remoteIdentifier);
    return remoteRows.find(row => normIdentifier(row.identifier) === target)?.identifier ?? null;
  }

  // Legacy-Fallback ohne verwertbares Repair-Secret: nur die alte HMAC-Evidenz
  // verwenden. Das kann nur Faelle aufloesen, in denen Remote- und Subject-ID
  // historisch identisch waren.
  return remoteRows.find(row =>
    matchesBanIdentifier(row.identifier, ban.identityHash, config.security.encryptionKey),
  )?.identifier ?? null;
}

async function reconcileLockedConnection(conn: BanReconcileConnection, now: Date, client?: Client): Promise<void> {
  if (!conn.nitradoServerId) return;

  // Erst lokale, exakt gescoppte Kandidaten feststellen. Connections ohne
  // bot-eigene Ban-Zeilen verursachen dadurch keinen unnoetigen Nitrado-Read.
  // Unbekannte Remote-Bans werden nie importiert oder als bot-eigene Wahrheit
  // interpretiert; nur bereits vorhandene lokale Ban-Zeilen werden verglichen.
  const local = await prisma.serverBanEntry.findMany({
    where: {
      guildId: conn.guildId,
      nitradoConnId: conn.id,
      OR: [
        { active: true },
        { appliedRemotely: true },
      ],
    },
    select: {
      id: true,
      identityHash: true,
      active: true,
      expiresAt: true,
      appliedRemotely: true,
    },
    orderBy: { updatedAt: 'asc' },
    take: BAN_BATCH,
  }) as BanRow[];

  if (local.length === 0) return;

  const identities = await prisma.serverBanRemoteIdentity.findMany({
    where: { banId: { in: local.map(row => row.id) } },
    select: { banId: true, identifierEnc: true, subjectIdentifierEnc: true },
  });
  const identityByBan = new Map<string, StoredIdentityRow>(identities.map(row => [
    row.banId,
    { identifierEnc: row.identifierEnc, subjectIdentifierEnc: row.subjectIdentifierEnc },
  ]));
  const decodedIdentityByBan = new Map(local.map(ban => [
    ban.id,
    decodeStoredIdentity(identityByBan.get(ban.id) ?? null, ban.identityHash),
  ] as const));

  const token = decrypt(conn.encryptedToken, config.security.encryptionKey);
  const api = new NitradoClient(token);
  let remoteRows = await api.getBanlist(conn.nitradoServerId);

  // `appliedRemotely=true -> remote fehlt` ist die sensible Drift-/Cleanup-
  // Entscheidung. Ein einzelner Remote-Snapshot reicht dafuer nicht. Unter dem
  // bereits gehaltenen Connection-Lock wird erneut gelesen; die Vereinigungs-
  // menge bedeutet konservativ: Abwesenheit gilt nur, wenn beide Reads fehlen.
  if (local.some(ban =>
    ban.appliedRemotely
    && !findRemoteIdentifier(
      remoteRows,
      ban,
      decodedIdentityByBan.get(ban.id) ?? { kind: 'MISSING' },
    ),
  )) {
    await delay(REMOTE_ABSENCE_CONFIRM_DELAY_MS);
    remoteRows = mergeRemoteRows(remoteRows, await api.getBanlist(conn.nitradoServerId));
  }

  const outbox = prisma as unknown as BanOutboxClient;

  let repairedAdds = 0;
  let queuedRemoves = 0;
  let backfilledSecrets = 0;
  let cleanedSecrets = 0;
  let correctedRemoteFlags = 0;
  let missingRepairSecrets = 0;
  let manualRemoteMissing = 0;
  let radarFenceRejected = 0;
  let repairedWhitelistMirrors = 0;

  for (const ban of local) {
    const fenceDecision = await inspectRadarAutoBanFenceForRemoteAdd(
      prisma,
      {
        guildId: conn.guildId,
        nitradoConnId: conn.id,
        banId: ban.id,
        currentServiceId: conn.nitradoServerId,
      },
    );
    if (fenceDecision.kind === 'REJECT') {
      // Weder ADD noch REMOVE noch Flag-Korrektur darf einen Radar-Ban auf eine
      // andere physische Server-/Binding-Generation umdeuten. Der Rebind-
      // Lifecycle deaktiviert solche Bans regulaer atomar; dies ist die zweite
      // fail-closed Verteidigung fuer Legacy-/Race-/Recovery-Zustaende.
      radarFenceRejected++;
      logAudit('RADAR_AUTO_BAN_RECONCILE_SKIPPED', 'MODERATION', {
        guildId: conn.guildId,
        nitradoConnId: conn.id,
        banId: ban.id,
        radarEventId: fenceDecision.fence.radarEventId,
        fenceServiceId: fenceDecision.fence.serviceId,
        fenceBindingVersion: fenceDecision.fence.bindingVersion,
        code: fenceDecision.code,
      });
      continue;
    }

    const locallyActive = isBanActive(ban, now);
    const storedIdentityRow = identityByBan.get(ban.id) ?? null;
    const storedIdentity = decodedIdentityByBan.get(ban.id) ?? { kind: 'MISSING' as const };

    // Bestands-Selbstheilung fuer den alten Case-Bug: Ein aktiver Ban und ein
    // gleichzeitig noch LOCAL_ONLY/SYNCED gefuehrter Whitelist-Eintrag koennen
    // fachlich nicht beide wahr sein. Hier ist ausdruecklich die interne
    // Subject-Identitaet relevant. Bei Radar bleibt das die GUID, auch wenn auf
    // Nitrado sichtbar der Spielername gebannt wird.
    if (locallyActive && storedIdentity.kind === 'VALID') {
      const repaired = await prisma.whitelistEntry.updateMany({
        where: {
          guildId: conn.guildId,
          nitradoConnId: conn.id,
          gameId: { equals: storedIdentity.subjectIdentifier, mode: 'insensitive' },
          syncState: { in: ['LOCAL_ONLY', 'SYNCED'] },
        },
        data: { syncState: 'PENDING_REMOVE', lastSyncedAt: null },
      });
      if (repaired.count > 0) {
        repairedWhitelistMirrors += repaired.count;
        await prisma.whitelistRequest.updateMany({
          where: {
            guildId: conn.guildId,
            nitradoConnId: conn.id,
            gameId: { equals: storedIdentity.subjectIdentifier, mode: 'insensitive' },
            status: { in: ['PENDING', 'APPROVED'] },
          },
          data: { status: 'CANCELLED' },
        });
      }
    }

    const remoteIdentifier = findRemoteIdentifier(remoteRows, ban, storedIdentity);

    if (locallyActive) {
      if (remoteIdentifier) {
        await clearNitradoDriftNotice(client, conn.guildId, conn.id, 'BAN', ban.id);
        if (!ban.appliedRemotely) {
          const updated = await prisma.serverBanEntry.updateMany({
            where: {
              id: ban.id,
              guildId: conn.guildId,
              nitradoConnId: conn.id,
              active: true,
            },
            data: { appliedRemotely: true },
          });
          correctedRemoteFlags += updated.count;
        }

        // Legacy-/Upgrade-Backfill: Dieser Pfad wird nur ohne gespeicherte
        // Identitaetszeile erreicht. Das Remote-Match stammt dann aus der HMAC-
        // Fallback-Pruefung, also sind Subject und Remote historisch identisch.
        if (!storedIdentityRow) {
          const identifierEnc = encrypt(remoteIdentifier, config.security.encryptionKey);
          await prisma.serverBanRemoteIdentity.upsert({
            where: { banId: ban.id },
            create: { banId: ban.id, identifierEnc, subjectIdentifierEnc: null },
            update: { identifierEnc, subjectIdentifierEnc: null },
          });
          const row = { identifierEnc, subjectIdentifierEnc: null };
          identityByBan.set(ban.id, row);
          decodedIdentityByBan.set(ban.id, {
            kind: 'VALID',
            remoteIdentifier,
            subjectIdentifier: remoteIdentifier,
          });
          backfilledSecrets++;
        }
        continue;
      }

      // Wurde dieser aktive Ban zuvor bereits remote bestaetigt und fehlt jetzt
      // in beiden stabilen Reads, ist das eine beobachtete Remote-Abweichung.
      // Der lokale Ban bleibt unveraendert; eine externe Aufhebung darf nicht
      // automatisch als autorisierte lokale Loeschung interpretiert werden.
      if (ban.appliedRemotely) {
        manualRemoteMissing++;
        if (client) await notifyNitradoBanDrift(client, { guildId: conn.guildId, nitradoConnId: conn.id, banId: ban.id });
        continue;
      }

      // appliedRemotely=false ist dagegen der normale ausstehende Soll-Zustand
      // fuer einen frisch angelegten Ban oder einen bewusst zur Reparatur
      // freigegebenen Eintrag. Nur diese Faelle duerfen automatisch ADDen.
      if (storedIdentity.kind === 'MISSING') {
        missingRepairSecrets++;
        logAudit('SERVER_BAN_RECONCILE_IDENTITY_MISSING', 'NITRADO', {
          guildId: conn.guildId,
          nitradoConnId: conn.id,
          banId: ban.id,
          action: 'REMOTE_ADD_SKIPPED',
        });
        continue;
      }

      if (storedIdentity.kind === 'CORRUPT' || storedIdentity.kind === 'MISMATCH') {
        missingRepairSecrets++;
        await prisma.serverBanRemoteIdentity.deleteMany({ where: { banId: ban.id } });
        identityByBan.delete(ban.id);
        decodedIdentityByBan.set(ban.id, { kind: 'MISSING' });
        logAudit(
          storedIdentity.kind === 'CORRUPT'
            ? 'SERVER_BAN_RECONCILE_IDENTITY_CORRUPT'
            : 'SERVER_BAN_RECONCILE_IDENTITY_MISMATCH',
          'NITRADO',
          {
            guildId: conn.guildId,
            nitradoConnId: conn.id,
            banId: ban.id,
            ...(storedIdentity.kind === 'CORRUPT'
              ? { error: 'Persistierte Server-Ban-Identitaet konnte nicht sicher entschluesselt werden.' }
              : {}),
          },
        );
        continue;
      }

      const remoteDiffers = normIdentifier(storedIdentity.remoteIdentifier)
        !== normIdentifier(storedIdentity.subjectIdentifier);
      if (await enqueueServerBanAdd(
        outbox,
        { guildId: conn.guildId, nitradoConnId: conn.id },
        ban.id,
        storedIdentity.subjectIdentifier,
        config.security.encryptionKey,
        {
          recentDeadCooldownMs: SERVER_BAN_ADD_AUTO_DEAD_COOLDOWN_MS,
          now,
          ...(remoteDiffers ? { remoteIdentifier: storedIdentity.remoteIdentifier } : {}),
        },
      )) {
        repairedAdds++;
      }
      continue;
    }

    // Inaktive/abgelaufene lokale Bans duerfen nur dann Remote-REMOVE erzeugen,
    // wenn genau ihre Remote-Identitaet noch beobachtet wird. Externe Bans,
    // fuer die es keine bot-eigene Ban-Zeile gibt, bleiben unangetastet.
    if (remoteIdentifier) {
      if (!ban.appliedRemotely) {
        const updated = await prisma.serverBanEntry.updateMany({
          where: { id: ban.id, guildId: conn.guildId, nitradoConnId: conn.id },
          data: { appliedRemotely: true },
        });
        correctedRemoteFlags += updated.count;
      }
      if (await enqueueServerBanRemove(
        outbox,
        { guildId: conn.guildId, nitradoConnId: conn.id },
        ban.id,
        { now },
      )) {
        queuedRemoves++;
      }
      continue;
    }

    if (ban.appliedRemotely) {
      const updated = await prisma.serverBanEntry.updateMany({
        where: { id: ban.id, guildId: conn.guildId, nitradoConnId: conn.id },
        data: { appliedRemotely: false },
      });
      correctedRemoteFlags += updated.count;
    }
    if (storedIdentityRow) {
      const deleted = await prisma.serverBanRemoteIdentity.deleteMany({ where: { banId: ban.id } });
      cleanedSecrets += deleted.count;
      identityByBan.delete(ban.id);
      decodedIdentityByBan.set(ban.id, { kind: 'MISSING' });
    }
  }

  if (
    repairedAdds > 0
    || queuedRemoves > 0
    || backfilledSecrets > 0
    || cleanedSecrets > 0
    || correctedRemoteFlags > 0
    || missingRepairSecrets > 0
    || manualRemoteMissing > 0
    || radarFenceRejected > 0
    || repairedWhitelistMirrors > 0
  ) {
    logAudit('SERVER_BAN_RECONCILED', 'NITRADO', {
      guildId: conn.guildId,
      nitradoConnId: conn.id,
      repairedAdds,
      queuedRemoves,
      backfilledSecrets,
      cleanedSecrets,
      correctedRemoteFlags,
      missingRepairSecrets,
      manualRemoteMissingObserved: manualRemoteMissing,
      radarFenceRejected,
      repairedWhitelistMirrors,
      remoteRows: remoteRows.length,
      localRows: local.length,
    });
  }
}

async function reconcileConnection(candidate: { id: string; guildId: string }, now: Date, client?: Client): Promise<void> {
  const lock = await tryAcquireNitradoConfigMutationLock(candidate.id);
  if (!lock) {
    logger.debug(`Server-Ban-Reconciliation fuer ${candidate.id} uebersprungen: Connection ist busy.`);
    return;
  }

  try {
    // Kandidaten-Snapshot ist nie Autoritaet. Token/Service werden erst nach
    // Lockgewinn frisch fuer exakt dieselbe Guild+Connection gelesen.
    const fresh = await prisma.nitradoConnection.findFirst({
      where: {
        id: candidate.id,
        guildId: candidate.guildId,
        status: 'ACTIVE',
        nitradoServerId: { not: null },
      },
      select: {
        id: true,
        guildId: true,
        encryptedToken: true,
        nitradoServerId: true,
      },
    });
    if (!fresh) return;
    await reconcileLockedConnection(fresh, now, client);
  } finally {
    await lock.release();
  }
}

export async function runBanReconciliationOnce(now = new Date(), client?: Client): Promise<void> {
  if (running) return;
  running = true;
  try {
    // Globaler Scan ist nur Kandidatenfindung. Die gescoppte Ban-Abfrage unter
    // Connection-Lock entscheidet danach, ob ueberhaupt ein Remote-Read noetig
    // ist. Eine Prisma-Relation vom Connection-Modell zur Ban-Tabelle ist dafuer
    // bewusst nicht erforderlich.
    // eslint-disable-next-line local/no-unscoped-prisma-query -- jede Verarbeitung wird danach exakt Guild+Connection scoped und unter dem kanonischen Connection-Lock frisch gelesen.
    const conns = await prisma.nitradoConnection.findMany({
      where: {
        status: 'ACTIVE',
        nitradoServerId: { not: null },
      },
      select: { id: true, guildId: true },
    });

    for (const conn of conns) {
      try {
        await reconcileConnection(conn, now, client);
      } catch (error) {
        logger.warn(`Server-Ban-Reconciliation fehlgeschlagen fuer ${conn.id}: ${safeError(error)}`);
      }
    }
  } finally {
    running = false;
  }
}

export function startBanReconciliationCron(client?: Client): void {
  if (timer) return;
  logger.info(`Server-Ban-Reconciliation gestartet (${RECONCILE_INTERVAL_MS / 1000}s).`);
  timer = setInterval(() => { void runBanReconciliationOnce(new Date(), client); }, RECONCILE_INTERVAL_MS);
  timer.unref?.();
  void runBanReconciliationOnce(new Date(), client);
}

export function stopBanReconciliationCron(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
