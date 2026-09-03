import prisma from '../../database/prisma';
import { config } from '../../config';
import { decrypt, encrypt } from '../../utils/security';
import { logger, logAudit } from '../../utils/logger';
import { NitradoClient } from '../nitrado/nitradoClient';
import { tryAcquireNitradoConfigMutationLock } from '../nitrado/configMutationLock';
import { isBanActive } from './banRegistry';
import { hashBanIdentifier, matchesBanIdentifier } from './banTarget';
import {
  enqueueServerBanAdd,
  enqueueServerBanRemove,
  SERVER_BAN_ADD_AUTO_DEAD_COOLDOWN_MS,
  type BanOutboxClient,
} from './banOutbox';

const RECONCILE_INTERVAL_MS = 60_000;
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

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .slice(0, 800);
}

async function reconcileLockedConnection(conn: BanReconcileConnection, now: Date): Promise<void> {
  if (!conn.nitradoServerId) return;

  // Erst lokale, exakt gescoppte Kandidaten feststellen. Connections ohne
  // bot-eigene Ban-Zeilen verursachen dadurch keinen unnoetigen Nitrado-Read.
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

  const token = decrypt(conn.encryptedToken, config.security.encryptionKey);
  const remoteRows = await new NitradoClient(token).getBanlist(conn.nitradoServerId);

  // Remote wird nur als Beobachtung benutzt. Unbekannte Remote-Bans werden nie
  // geloescht oder als bot-eigene Wahrheit importiert.
  const remoteByHash = new Map<string, string>();
  for (const remote of remoteRows) {
    const identifier = remote.identifier.trim();
    if (!identifier) continue;
    const identityHash = hashBanIdentifier(identifier, config.security.encryptionKey);
    if (!remoteByHash.has(identityHash)) remoteByHash.set(identityHash, identifier);
  }

  const identities = await prisma.serverBanRemoteIdentity.findMany({
    where: { banId: { in: local.map(row => row.id) } },
    select: { banId: true, identifierEnc: true },
  });
  const identityByBan = new Map(identities.map(row => [row.banId, row.identifierEnc]));
  const outbox = prisma as unknown as BanOutboxClient;

  let repairedAdds = 0;
  let queuedRemoves = 0;
  let backfilledSecrets = 0;
  let cleanedSecrets = 0;
  let correctedRemoteFlags = 0;
  let missingRepairSecrets = 0;
  let manualRemoteMissing = 0;

  for (const ban of local) {
    const locallyActive = isBanActive(ban, now);
    const remoteIdentifier = remoteByHash.get(ban.identityHash) ?? null;
    const storedIdentityEnc = identityByBan.get(ban.id) ?? null;

    if (locallyActive) {
      if (remoteIdentifier) {
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

        // Legacy-/Upgrade-Backfill: Ein bereits remote vorhandener aktiver Ban
        // liefert den exakten Identifier. Er wird ausschliesslich verschluesselt
        // persistiert und kann kuenftige Drift-/Rebind-Reparaturen speisen.
        if (!storedIdentityEnc) {
          const identifierEnc = encrypt(remoteIdentifier, config.security.encryptionKey);
          await prisma.serverBanRemoteIdentity.upsert({
            where: { banId: ban.id },
            create: { banId: ban.id, identifierEnc },
            update: { identifierEnc },
          });
          identityByBan.set(ban.id, identifierEnc);
          backfilledSecrets++;
        }
        continue;
      }

      // Wurde dieser aktive Ban zuvor bereits remote bestaetigt und fehlt jetzt
      // ploetzlich, ist das eine beobachtete Remote-Abweichung. Der lokale Ban
      // bleibt unveraendert; eine externe Aufhebung darf nicht automatisch als
      // autorisierte lokale Loeschung interpretiert werden.
      if (ban.appliedRemotely) {
        manualRemoteMissing++;
        continue;
      }

      // appliedRemotely=false ist dagegen der normale ausstehende Soll-Zustand
      // fuer einen frisch angelegten Ban oder einen bewusst zur Reparatur
      // freigegebenen Eintrag. Nur diese Faelle duerfen automatisch ADDen.
      if (!storedIdentityEnc) {
        missingRepairSecrets++;
        logAudit('SERVER_BAN_RECONCILE_IDENTITY_MISSING', 'NITRADO', {
          guildId: conn.guildId,
          nitradoConnId: conn.id,
          banId: ban.id,
          action: 'REMOTE_ADD_SKIPPED',
        });
        continue;
      }

      let identifier: string;
      try {
        identifier = decrypt(storedIdentityEnc, config.security.encryptionKey);
      } catch (error) {
        missingRepairSecrets++;
        await prisma.serverBanRemoteIdentity.deleteMany({ where: { banId: ban.id } });
        identityByBan.delete(ban.id);
        logAudit('SERVER_BAN_RECONCILE_IDENTITY_CORRUPT', 'NITRADO', {
          guildId: conn.guildId,
          nitradoConnId: conn.id,
          banId: ban.id,
          error: safeError(error),
        });
        continue;
      }

      if (!matchesBanIdentifier(identifier, ban.identityHash, config.security.encryptionKey)) {
        missingRepairSecrets++;
        await prisma.serverBanRemoteIdentity.deleteMany({ where: { banId: ban.id } });
        identityByBan.delete(ban.id);
        logAudit('SERVER_BAN_RECONCILE_IDENTITY_MISMATCH', 'NITRADO', {
          guildId: conn.guildId,
          nitradoConnId: conn.id,
          banId: ban.id,
        });
        continue;
      }

      if (await enqueueServerBanAdd(
        outbox,
        { guildId: conn.guildId, nitradoConnId: conn.id },
        ban.id,
        identifier,
        config.security.encryptionKey,
        { recentDeadCooldownMs: SERVER_BAN_ADD_AUTO_DEAD_COOLDOWN_MS, now },
      )) {
        repairedAdds++;
      }
      continue;
    }

    // Inaktive/abgelaufene lokale Bans duerfen nur dann Remote-REMOVE erzeugen,
    // wenn genau ihre HMAC-Identitaet noch remote beobachtet wird. Externe Bans,
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
    if (storedIdentityEnc) {
      const deleted = await prisma.serverBanRemoteIdentity.deleteMany({ where: { banId: ban.id } });
      cleanedSecrets += deleted.count;
      identityByBan.delete(ban.id);
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
      remoteRows: remoteRows.length,
      localRows: local.length,
    });
  }
}

async function reconcileConnection(candidate: { id: string; guildId: string }, now: Date): Promise<void> {
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
    await reconcileLockedConnection(fresh, now);
  } finally {
    await lock.release();
  }
}

export async function runBanReconciliationOnce(now = new Date()): Promise<void> {
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
        await reconcileConnection(conn, now);
      } catch (error) {
        logger.warn(`Server-Ban-Reconciliation fehlgeschlagen fuer ${conn.id}: ${safeError(error)}`);
      }
    }
  } finally {
    running = false;
  }
}

export function startBanReconciliationCron(): void {
  if (timer) return;
  logger.info(`Server-Ban-Reconciliation gestartet (${RECONCILE_INTERVAL_MS / 1000}s).`);
  timer = setInterval(() => { void runBanReconciliationOnce(); }, RECONCILE_INTERVAL_MS);
  timer.unref?.();
  void runBanReconciliationOnce();
}

export function stopBanReconciliationCron(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
