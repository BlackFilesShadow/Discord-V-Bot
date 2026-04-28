import { Client, TextChannel } from 'discord.js';
import prisma from '../../database/prisma';
import { logger } from '../../utils/logger';
import { Colors, Brand, vEmbed } from '../../utils/embedDesign';
import { safeSend } from '../../utils/safeSend';

/**
 * Persistente Leaderboard-Feeds.
 *
 * Statt In-Memory-Timer (verloren bei Restart, nicht channeluebergreifend
 * stoppbar) werden Feeds in BotConfig persistiert und beim Start des Bots
 * wieder als Intervalle registriert.
 *
 * BotConfig:
 *   key   = "leaderboard_feed:<channelId>"
 *   value = { guildId, channelId, sortBy, intervalMinutes }
 */

const KEY_PREFIX = 'leaderboard_feed:';

export type FeedSortBy = 'xp' | 'level' | 'messages' | 'voice';

export interface LeaderboardFeed {
  guildId: string;
  channelId: string;
  sortBy: FeedSortBy;
  intervalMinutes: number;
}

const activeTimers = new Map<string, NodeJS.Timeout>();

function key(channelId: string): string {
  return `${KEY_PREFIX}${channelId}`;
}

function isFeedSortBy(v: unknown): v is FeedSortBy {
  return v === 'xp' || v === 'level' || v === 'messages' || v === 'voice';
}

function parseFeed(value: unknown): LeaderboardFeed | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.guildId !== 'string') return null;
  if (typeof v.channelId !== 'string') return null;
  if (!isFeedSortBy(v.sortBy)) return null;
  if (typeof v.intervalMinutes !== 'number' || v.intervalMinutes < 1) return null;
  return {
    guildId: v.guildId,
    channelId: v.channelId,
    sortBy: v.sortBy,
    intervalMinutes: v.intervalMinutes,
  };
}

export async function saveFeed(feed: LeaderboardFeed): Promise<void> {
  await prisma.botConfig.upsert({
    where: { key: key(feed.channelId) },
    create: {
      key: key(feed.channelId),
      value: feed as unknown as object,
      category: 'leaderboard',
      description: `Leaderboard-Feed für Channel ${feed.channelId}`,
    },
    update: { value: feed as unknown as object },
  });
}

export async function deleteFeed(channelId: string): Promise<void> {
  await prisma.botConfig.deleteMany({ where: { key: key(channelId) } });
  const t = activeTimers.get(channelId);
  if (t) {
    clearInterval(t);
    activeTimers.delete(channelId);
  }
}

export async function getAllFeeds(): Promise<LeaderboardFeed[]> {
  const rows = await prisma.botConfig.findMany({
    where: { key: { startsWith: KEY_PREFIX } },
  });
  const out: LeaderboardFeed[] = [];
  for (const r of rows) {
    const f = parseFeed(r.value);
    if (f) out.push(f);
  }
  return out;
}

const SORT_LABEL: Record<FeedSortBy, string> = {
  xp: 'XP', level: 'Level', messages: 'Nachrichten', voice: 'Voice-Minuten',
};

export async function buildLeaderboardEmbed(
  guildId: string,
  sortBy: FeedSortBy,
  page = 1,
) {
  const perPage = 10;
  const skip = (page - 1) * perPage;
  const orderBy: Record<string, 'desc'> =
    sortBy === 'level' ? { level: 'desc' } :
    sortBy === 'messages' ? { totalMessages: 'desc' } :
    sortBy === 'voice' ? { voiceMinutes: 'desc' } :
    { xp: 'desc' };

  const [entries, total] = await Promise.all([
    prisma.levelData.findMany({
      where: { guildId },
      orderBy,
      skip,
      take: perPage,
      include: { user: true },
    }),
    prisma.levelData.count({ where: { guildId } }),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const medals = ['🥇', '🥈', '🥉'];

  const lines = entries.length === 0
    ? ['_Noch keine Level-Daten._']
    : entries.map((entry, i) => {
        const position = skip + i + 1;
        const medal = position <= 3 ? medals[position - 1] : `**${position}.**`;
        const xp = Number(entry.xp).toLocaleString('de-DE');
        const valueStr =
          sortBy === 'level' ? `Level ${entry.level}` :
          sortBy === 'messages' ? `${entry.totalMessages.toLocaleString('de-DE')} Nachrichten` :
          sortBy === 'voice' ? `${entry.voiceMinutes.toLocaleString('de-DE')} Min` :
          `${xp} XP (Lvl ${entry.level})`;
        return `${medal} <@${entry.user.discordId}> — ${valueStr}`;
      });

  return vEmbed(Colors.Gold)
    .setTitle(`🏆  Bestenliste — ${SORT_LABEL[sortBy]}`)
    .setDescription(`${Brand.divider}\n\n${lines.join('\n')}\n\n${Brand.divider}`)
    .setFooter({ text: `Seite ${page}/${totalPages} ${Brand.dot} ${total} Mitglieder ${Brand.dot} ${Brand.footerText}` });
}

function startTimer(client: Client, feed: LeaderboardFeed): void {
  // Vorherigen Timer ggf. ersetzen.
  const prev = activeTimers.get(feed.channelId);
  if (prev) clearInterval(prev);

  const t = setInterval(async () => {
    try {
      const ch = await client.channels.fetch(feed.channelId).catch(() => null);
      if (!ch || !('send' in ch)) {
        // Channel weg → Feed automatisch aufräumen.
        await deleteFeed(feed.channelId);
        return;
      }
      const embed = await buildLeaderboardEmbed(feed.guildId, feed.sortBy);
      await safeSend(ch as TextChannel, { embeds: [embed] });
    } catch (e) {
      logger.warn(`leaderboard-feed[${feed.channelId}] tick failed: ${String(e)}`);
    }
  }, feed.intervalMinutes * 60_000);

  t.unref?.();
  activeTimers.set(feed.channelId, t);
}

export async function startFeed(client: Client, feed: LeaderboardFeed): Promise<void> {
  await saveFeed(feed);
  startTimer(client, feed);
}

export async function restoreAllFeeds(client: Client): Promise<void> {
  const feeds = await getAllFeeds();
  for (const f of feeds) startTimer(client, f);
  if (feeds.length > 0) logger.info(`Leaderboard-Feeds wiederhergestellt: ${feeds.length}`);
}
