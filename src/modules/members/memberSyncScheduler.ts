import type { Client, Guild } from 'discord.js';
import prisma from '../../database/prisma';
import { logger } from '../../utils/logger';
import { config } from '../../config';
import { syncMemberProfile } from '../ai/memberAwareness';

/**
 * Spec §11: Periodischer Member-Sync-Job.
 *
 * Ziel: Die GuildMemberProfile-Tabelle aktuell halten, auch wenn ein Member
 * nie eine Nachricht schreibt (messageCreate triggert sonst nichts). Pro Guild
 * werden alle Mitglieder gefetcht, geupsertet und Karteileichen als verlassen
 * markiert (nicht geloescht — Audit-Spuren bleiben).
 *
 * Standardmaessig AUS (MEMBER_SYNC_ENABLED=false). Wenn aktiv, laeuft der Job
 * alle config.member.syncIntervalHours Stunden plus einmal kurz nach Start.
 * Rate-limit-freundlich: Guilds und Member-Upserts werden sequenziell mit
 * kleinen Pausen abgearbeitet.
 */

let timer: NodeJS.Timeout | null = null;
let running = false;

export interface MemberSyncStatus {
  running: boolean;
  lastRunAt: string | null;
  lastDurationMs: number | null;
  lastGuilds: number | null;
  lastFetched: number | null;
  lastUpserted: number | null;
  lastMarkedLeft: number | null;
  lastError: string | null;
}

const status: MemberSyncStatus = {
  running: false,
  lastRunAt: null,
  lastDurationMs: null,
  lastGuilds: null,
  lastFetched: null,
  lastUpserted: null,
  lastMarkedLeft: null,
  lastError: null,
};

export function getMemberSyncStatus(): MemberSyncStatus {
  return { ...status, running };
}

const STARTUP_DELAY_MS = 60 * 1000; // 1 min nach ready, damit Cache/Logins fertig sind
const GUILD_PAUSE_MS = 2 * 1000; // Pause zwischen Guilds
const UPSERT_PAUSE_MS = 25; // kleine Pause zwischen einzelnen Upserts

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface GuildSyncStats {
  guildId: string;
  fetched: number;
  upserted: number;
  markedLeft: number;
}

async function syncGuild(guild: Guild): Promise<GuildSyncStats> {
  const stats: GuildSyncStats = { guildId: guild.id, fetched: 0, upserted: 0, markedLeft: 0 };

  const members = await guild.members.fetch();
  stats.fetched = members.size;

  const seen = new Set<string>();
  for (const member of members.values()) {
    if (member.user.bot) continue;
    seen.add(member.id);
    await syncMemberProfile(member);
    stats.upserted += 1;
    if (UPSERT_PAUSE_MS > 0) await sleep(UPSERT_PAUSE_MS);
  }

  // Karteileichen: in DB aktiv, aber nicht mehr in der Guild -> als verlassen markieren.
  const active = await prisma.guildMemberProfile.findMany({
    where: { guildId: guild.id, isLeft: false },
    select: { discordId: true },
  });
  const stale = active.filter((row) => !seen.has(row.discordId)).map((row) => row.discordId);
  if (stale.length > 0) {
    const res = await prisma.guildMemberProfile.updateMany({
      where: { guildId: guild.id, discordId: { in: stale }, isLeft: false },
      data: { isLeft: true, leftAt: new Date() },
    });
    stats.markedLeft = res.count;
  }

  return stats;
}

export async function runMemberSyncOnce(client: Client): Promise<void> {
  if (running) {
    logger.warn('memberSync: vorheriger Lauf noch aktiv, ueberspringe.');
    return;
  }
  running = true;
  const startedAt = Date.now();
  let totalFetched = 0;
  let totalUpserted = 0;
  let totalLeft = 0;
  try {
    const guilds = [...client.guilds.cache.values()];
    for (const guild of guilds) {
      try {
        const s = await syncGuild(guild);
        totalFetched += s.fetched;
        totalUpserted += s.upserted;
        totalLeft += s.markedLeft;
      } catch (e) {
        logger.warn(`memberSync: Guild ${guild.id} fehlgeschlagen: ${String(e)}`);
      }
      if (GUILD_PAUSE_MS > 0) await sleep(GUILD_PAUSE_MS);
    }
    logger.info(
      `memberSync: fertig (${guilds.length} Guilds, ${totalFetched} gefetcht, ` +
        `${totalUpserted} aktualisiert, ${totalLeft} als verlassen markiert) in ${Date.now() - startedAt}ms.`,
    );
    status.lastRunAt = new Date().toISOString();
    status.lastDurationMs = Date.now() - startedAt;
    status.lastGuilds = guilds.length;
    status.lastFetched = totalFetched;
    status.lastUpserted = totalUpserted;
    status.lastMarkedLeft = totalLeft;
    status.lastError = null;
  } catch (e) {
    status.lastRunAt = new Date().toISOString();
    status.lastError = String(e);
    logger.error('memberSync-Lauf-Fehler:', e as Error);
  } finally {
    running = false;
  }
}

export function startMemberSyncScheduler(client: Client): void {
  if (!config.member.syncEnabled) {
    logger.info('memberSync: deaktiviert (MEMBER_SYNC_ENABLED=false).');
    return;
  }
  if (timer) return;

  const intervalMs = config.member.syncIntervalHours * 60 * 60 * 1000;

  setTimeout(() => {
    void runMemberSyncOnce(client).catch((e) => logger.error('memberSync-Startlauf-Fehler:', e as Error));
  }, STARTUP_DELAY_MS).unref?.();

  timer = setInterval(() => {
    void runMemberSyncOnce(client).catch((e) => logger.error('memberSync-Fehler:', e as Error));
  }, intervalMs);
  timer.unref?.();

  logger.info(`memberSync: gestartet (alle ${config.member.syncIntervalHours}h).`);
}

export function stopMemberSyncScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
