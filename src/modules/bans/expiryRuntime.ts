/**
 * Runtime fuer zeitlich begrenzte Gameserver-Banns.
 *
 * Zwei strikt getrennte Schritte:
 * 1. Ablauf-Reconcile (alle 5s): expired + remote => REMOVE-Outbox; expired +
 *    remote bereits weg => lokale Ban-Wahrheit finalisieren und Notice READY.
 * 2. Discord-Notice: erst NACH bestaetigtem Remote-Unban. Retry/Lease und ein
 *    stabiler, unsichtbarer Discord-Nonce verhindern verlorene oder doppelte
 *    Meldungen, ohne technische IDs im Embed anzuzeigen.
 */

import { EmbedBuilder, type GuildTextBasedChannel } from 'discord.js';
import prisma from '../../database/prisma';
import { config } from '../../config';
import { decrypt } from '../../utils/security';
import { logger, logAudit } from '../../utils/logger';
import { tryGetDashboardClient } from '../../dashboard/clientRegistry';
import { enqueueServerBanRemove, type BanOutboxClient } from './banOutbox';

// Niedriger gehalten als die meisten anderen Cron-Intervalle: dieser Tick ist
// die einzige Quelle fuer die Ablauf-Erkennung UND die Notice-Zustellung eines
// temporaeren Bans, ihre Latenz ist direkt nutzerspuerbar (Produktions-Messung
// zeigte 51s End-zu-End bei 5s Intervall).
const POLL_INTERVAL_MS = 2_000;
const NOTICE_LEASE_MS = 60_000;
const MAX_NOTICE_ATTEMPTS = 8;
const NOTICE_BATCH = 25;
const EXPIRED_BATCH = 200;

let timer: NodeJS.Timeout | null = null;
let running = false;

function retryDelayMs(attempt: number): number {
  return Math.min(15 * 60_000, 15_000 * Math.pow(2, Math.max(0, attempt - 1)));
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .slice(0, 1000);
}

function safeText(value: string | null | undefined, fallback = '—'): string {
  const text = (value ?? '').replace(/[\r\n]+/g, ' ').trim();
  return text || fallback;
}

/**
 * Finalisiert ausschliesslich echte ZEITABLAEUFE. Manuelle /server-unban-
 * Vorgaenge setzen `active=false` und werden von dieser Query nicht erfasst.
 */
export async function reconcileExpiredServerBansOnce(now = new Date()): Promise<void> {
  // eslint-disable-next-line local/no-unscoped-prisma-query -- globaler Scheduler-Sweep ueber eigene Ban-Registry; jede Mutation bleibt Guild+Connection scoped.
  const expired = await prisma.serverBanEntry.findMany({
    where: {
      active: true,
      expiresAt: { not: null, lte: now },
    },
    select: {
      id: true,
      guildId: true,
      nitradoConnId: true,
      appliedRemotely: true,
    },
    orderBy: { expiresAt: 'asc' },
    take: EXPIRED_BATCH,
  });

  for (const ban of expired) {
    if (ban.appliedRemotely) {
      await enqueueServerBanRemove(
        prisma as unknown as BanOutboxClient,
        { guildId: ban.guildId, nitradoConnId: ban.nitradoConnId },
        ban.id,
      );
      continue;
    }

    // Remote ist bestaetigt weg (oder wurde nie gesetzt). Erst JETZT lokal
    // finalisieren und die Ablaufmeldung freigeben.
    await prisma.$transaction(async tx => {
      const lifted = await tx.serverBanEntry.updateMany({
        where: {
          id: ban.id,
          guildId: ban.guildId,
          nitradoConnId: ban.nitradoConnId,
          active: true,
          appliedRemotely: false,
          expiresAt: { not: null, lte: now },
        },
        data: { active: false, liftedAt: now },
      });
      if (lifted.count !== 1) return;

      await tx.serverBanExpiryNotice.updateMany({
        where: {
          banId: ban.id,
          guildId: ban.guildId,
          nitradoConnId: ban.nitradoConnId,
          status: 'PENDING',
        },
        data: {
          status: 'READY',
          remoteRemovedAt: now,
          nextAttemptAt: now,
          lastError: null,
        },
      });
    });

    logAudit('SERVER_BAN_EXPIRED', 'MODERATION', {
      guildId: ban.guildId,
      nitradoConnId: ban.nitradoConnId,
      banId: ban.id,
      remoteRemoved: true,
    });
  }
}

async function markNoticeSent(id: string, messageId: string): Promise<void> {
  await prisma.serverBanExpiryNotice.updateMany({
    where: { id, status: 'SENDING' },
    data: {
      status: 'SENT',
      sentAt: new Date(),
      messageId,
      identifierEnc: null,
      leaseUntil: null,
      lastError: null,
    },
  });
}

async function failNotice(
  id: string,
  attemptsBefore: number,
  error: unknown,
): Promise<void> {
  const attempts = attemptsBefore + 1;
  const failed = attempts >= MAX_NOTICE_ATTEMPTS;
  await prisma.serverBanExpiryNotice.updateMany({
    where: { id, status: 'SENDING' },
    data: {
      status: failed ? 'FAILED' : 'READY',
      attempts,
      nextAttemptAt: new Date(Date.now() + retryDelayMs(attempts)),
      leaseUntil: null,
      lastError: safeError(error),
    },
  });
}

async function cancelStaleNotice(id: string, reason: string): Promise<void> {
  await prisma.serverBanExpiryNotice.updateMany({
    where: { id, status: 'SENDING' },
    data: {
      status: 'CANCELLED',
      identifierEnc: null,
      leaseUntil: null,
      lastError: reason,
    },
  });
}

async function deliverNotice(notice: {
  id: string;
  banId: string;
  guildId: string;
  nitradoConnId: string;
  channelId: string;
  identifierEnc: string | null;
  expiresAt: Date;
  attempts: number;
}): Promise<void> {
  const claimed = await prisma.serverBanExpiryNotice.updateMany({
    where: {
      id: notice.id,
      status: 'READY',
      nextAttemptAt: { lte: new Date() },
    },
    data: {
      status: 'SENDING',
      leaseUntil: new Date(Date.now() + NOTICE_LEASE_MS),
    },
  });
  if (claimed.count !== 1) return;

  try {
    const [ban, connection] = await Promise.all([
      prisma.serverBanEntry.findFirst({
        where: {
          id: notice.banId,
          guildId: notice.guildId,
          nitradoConnId: notice.nitradoConnId,
          active: false,
          appliedRemotely: false,
          expiresAt: notice.expiresAt,
        },
        select: { reason: true, liftedAt: true },
      }),
      prisma.nitradoConnection.findFirst({
        where: { id: notice.nitradoConnId, guildId: notice.guildId },
        select: { alias: true },
      }),
    ]);
    if (!ban) {
      await cancelStaleNotice(notice.id, 'Ban wurde vor der Ablaufmeldung geaendert oder erneut aktiviert.');
      return;
    }

    let identifier = 'Spieler';
    if (notice.identifierEnc) {
      try {
        identifier = safeText(decrypt(notice.identifierEnc, config.security.encryptionKey), 'Spieler');
      } catch {
        identifier = 'Spieler';
      }
    }

    const client = tryGetDashboardClient();
    if (!client) throw new Error('Discord-Client nicht verfuegbar.');
    const channel = await client.channels.fetch(notice.channelId).catch(() => null);
    if (!channel || !channel.isTextBased() || channel.isDMBased()) {
      throw new Error('Urspruenglicher Command-Kanal ist nicht mehr verfuegbar.');
    }
    const textChannel = channel as GuildTextBasedChannel;
    if (textChannel.guildId !== notice.guildId) throw new Error('Command-Kanal gehoert nicht zur erwarteten Guild.');

    // Letzte kanonische Race-Pruefung direkt vor dem externen Discord-Sideeffect:
    // Ein Re-Ban setzt die Notice wieder PENDING und `active=true`, ein manueller
    // Unban setzt sie CANCELLED. In beiden Faellen darf keine alte
    // "Strafe vorbei"-Meldung mehr gesendet werden.
    const [freshNotice, freshBan] = await Promise.all([
      prisma.serverBanExpiryNotice.findFirst({
        where: {
          id: notice.id,
          banId: notice.banId,
          guildId: notice.guildId,
          nitradoConnId: notice.nitradoConnId,
          status: 'SENDING',
          expiresAt: notice.expiresAt,
        },
        select: { id: true },
      }),
      prisma.serverBanEntry.findFirst({
        where: {
          id: notice.banId,
          guildId: notice.guildId,
          nitradoConnId: notice.nitradoConnId,
          active: false,
          appliedRemotely: false,
          expiresAt: notice.expiresAt,
        },
        select: { id: true },
      }),
    ]);
    if (!freshNotice || !freshBan) {
      await cancelStaleNotice(notice.id, 'Ablaufmeldung wegen zwischenzeitlicher Ban-Aenderung verworfen.');
      return;
    }

    const serverLabel = connection?.alias?.trim() || 'Gameserver';
    const expiresUnix = Math.floor(notice.expiresAt.getTime() / 1000);
    const embed = new EmbedBuilder()
      .setColor(0x22c55e)
      .setTitle('✅ Server-Bann abgelaufen')
      .setDescription(`Die zeitlich begrenzte Strafe von **${identifier}** ist beendet.`)
      .addFields(
        { name: 'Server', value: serverLabel, inline: true },
        { name: 'Bann abgelaufen', value: `<t:${expiresUnix}:R>`, inline: true },
        { name: 'Grund', value: safeText(ban.reason), inline: false },
        { name: 'Status', value: '✅ Von der Nitrado-Bannliste entfernt', inline: false },
      )
      .setFooter({ text: 'Automatischer Ablauf • V Bot' })
      .setTimestamp(ban.liftedAt ?? new Date());

    const message = await textChannel.send({
      embeds: [embed],
      allowedMentions: { parse: [] },
      // Technische Deduplizierung bleibt unsichtbar statt als Ban-/Notice-ID im Footer.
      nonce: notice.id.slice(0, 25),
      enforceNonce: true,
    });
    await markNoticeSent(notice.id, message.id);

    logAudit('SERVER_BAN_EXPIRY_NOTICE_SENT', 'MODERATION', {
      guildId: notice.guildId,
      nitradoConnId: notice.nitradoConnId,
      banId: notice.banId,
      channelId: notice.channelId,
      messageId: message.id,
    });
  } catch (error) {
    await failNotice(notice.id, notice.attempts, error);
  }
}

export async function runBanExpiryRuntimeOnce(now = new Date()): Promise<void> {
  if (running) return;
  running = true;
  try {
    await reconcileExpiredServerBansOnce(now);

    // Crash-Recovery fuer Notice-Leases.
    // eslint-disable-next-line local/no-unscoped-prisma-query -- globaler Recovery-Sweep ueber eigene Notice-Outbox.
    await prisma.serverBanExpiryNotice.updateMany({
      where: { status: 'SENDING', leaseUntil: { lt: now } },
      data: {
        status: 'READY',
        attempts: { increment: 1 },
        nextAttemptAt: now,
        leaseUntil: null,
        lastError: 'Notice lease expired; reconciliation required',
      },
    });

    // eslint-disable-next-line local/no-unscoped-prisma-query -- Scheduler iteriert eigene READY-Outbox; deliverNotice validiert Guild+Connection+Channel erneut.
    const due = await prisma.serverBanExpiryNotice.findMany({
      where: { status: 'READY', nextAttemptAt: { lte: now } },
      orderBy: [{ nextAttemptAt: 'asc' }, { createdAt: 'asc' }],
      take: NOTICE_BATCH,
      select: {
        id: true,
        banId: true,
        guildId: true,
        nitradoConnId: true,
        channelId: true,
        identifierEnc: true,
        expiresAt: true,
        attempts: true,
      },
    });
    for (const notice of due) await deliverNotice(notice);
  } catch (error) {
    logger.error('Server-Ban-Ablauf-Runtime Fehler:', error as Error);
  } finally {
    running = false;
  }
}

export function startBanExpiryRuntime(): void {
  if (timer) return;
  logger.info(`Server-Ban-Ablauf-Runtime gestartet (Intervall ${POLL_INTERVAL_MS}ms).`);
  timer = setInterval(() => { void runBanExpiryRuntimeOnce(); }, POLL_INTERVAL_MS);
  timer.unref?.();
  void runBanExpiryRuntimeOnce();
}

export function stopBanExpiryRuntime(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
