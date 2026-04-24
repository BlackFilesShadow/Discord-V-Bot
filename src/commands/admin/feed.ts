import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
} from 'discord.js';
import { Command } from '../../types';
import prisma from '../../database/prisma';
import { createFeed } from '../../modules/feeds/feedManager';
import { logAudit, logger } from '../../utils/logger';

/**
 * Validiert einen Feed-Source-Wert je nach Typ. Verhindert das stumme
 * Anlegen kaputter Feeds.
 */
function validateFeedSource(typ: string, source: string): { ok: true } | { ok: false; reason: string } {
  const trimmed = source.trim();
  if (!trimmed) return { ok: false, reason: 'URL/Quelle darf nicht leer sein.' };
  if (trimmed.length > 2048) return { ok: false, reason: 'URL/Quelle ueberschreitet 2048 Zeichen.' };

  switch (typ) {
    case 'RSS':
    case 'NEWS':
    case 'WEBHOOK': {
      try {
        const u = new URL(trimmed);
        if (!['http:', 'https:'].includes(u.protocol)) {
          return { ok: false, reason: 'Nur http:// oder https:// URLs erlaubt.' };
        }
        if (u.hostname === 'localhost' || u.hostname.startsWith('127.') || u.hostname === '0.0.0.0') {
          return { ok: false, reason: 'Lokale/private Hosts sind nicht erlaubt (SSRF-Schutz).' };
        }
        return { ok: true };
      } catch {
        return { ok: false, reason: 'Ungueltige URL.' };
      }
    }
    case 'TWITCH': {
      // Twitch-Channelname: 4-25 Zeichen, alphanumerisch + _.
      if (!/^[A-Za-z0-9_]{4,25}$/.test(trimmed)) {
        return { ok: false, reason: 'Twitch-Channelname muss 4-25 Zeichen aus [A-Za-z0-9_] sein.' };
      }
      return { ok: true };
    }
    case 'STEAM': {
      // Steam App-ID: numerisch.
      if (!/^\d{1,10}$/.test(trimmed)) {
        return { ok: false, reason: 'Steam-App-ID muss numerisch sein (z.B. 730).' };
      }
      return { ok: true };
    }
    default:
      return { ok: true };
  }
}

/**
 * /feed Command (Sektion 7):
 * - Live-Verlinkung: News, Streams, Social Media, RSS, Echtzeit-Feeds
 * - Filter, Benachrichtigungen
 */
const feedCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('feed')
    .setDescription('Live-Feeds und externe Dienste verwalten')
    .addSubcommand(sub =>
      sub
        .setName('erstellen')
        .setDescription('Neuen Feed erstellen')
        .addStringOption(opt =>
          opt.setName('name').setDescription('Feed-Name').setRequired(true)
        )
        .addStringOption(opt =>
          opt
            .setName('typ')
            .setDescription('Feed-Typ')
            .setRequired(true)
            .addChoices(
              { name: 'RSS', value: 'RSS' },
              { name: 'Twitch', value: 'TWITCH' },
              { name: 'Steam', value: 'STEAM' },
              { name: 'News', value: 'NEWS' },
              { name: 'Webhook', value: 'WEBHOOK' },
            )
        )
        .addStringOption(opt =>
          opt.setName('url').setDescription('URL / Channel-Name / App-ID').setRequired(true)
        )
        .addChannelOption(opt =>
          opt.setName('channel').setDescription('Ziel-Channel für Updates').setRequired(true)
        )
        .addIntegerOption(opt =>
          opt
            .setName('intervall')
            .setDescription('Prüfintervall in Sekunden (min 60)')
            .setRequired(false)
            .setMinValue(60)
            .setMaxValue(86400)
        )
    )
    .addSubcommand(sub =>
      sub.setName('liste').setDescription('Alle Feeds anzeigen')
    )
    .addSubcommand(sub =>
      sub
        .setName('loeschen')
        .setDescription('Feed löschen')
        .addStringOption(opt =>
          opt.setName('feed-id').setDescription('Feed-ID').setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('toggle')
        .setDescription('Feed aktivieren/deaktivieren')
        .addStringOption(opt =>
          opt.setName('feed-id').setDescription('Feed-ID').setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('abonnieren')
        .setDescription('Feed abonnieren (DM-Benachrichtigungen)')
        .addStringOption(opt =>
          opt.setName('feed-id').setDescription('Feed-ID').setRequired(true)
        )
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels) as SlashCommandBuilder,
  adminOnly: true,

  execute: async (interaction: ChatInputCommandInteraction) => {
    await interaction.deferReply({ ephemeral: true });

    const sub = interaction.options.getSubcommand();

    switch (sub) {
      case 'erstellen': {
        const name = interaction.options.getString('name', true);
        const typ = interaction.options.getString('typ', true);
        const url = interaction.options.getString('url', true);
        const channel = interaction.options.getChannel('channel', true);
        const intervall = interaction.options.getInteger('intervall') || 300;

        // Quelle/URL validieren BEVOR wir die DB anfassen.
        const v = validateFeedSource(typ, url);
        if (!v.ok) {
          await interaction.editReply({ content: `❌ Feed-Quelle ungueltig: ${v.reason}` });
          return;
        }

        let feedId: string;
        try {
          feedId = await createFeed(
            name, typ, url.trim(), channel.id, intervall, interaction.user.id,
          );
        } catch (e) {
          logger.warn(`feed.erstellen fehlgeschlagen: ${String(e)}`);
          await interaction.editReply({ content: `❌ Feed konnte nicht angelegt werden: ${String((e as Error)?.message ?? e).slice(0, 500)}` });
          return;
        }

        const embed = new EmbedBuilder()
          .setTitle('📡 Feed erstellt')
          .setColor(0x2ecc71)
          .addFields(
            { name: 'Name', value: name, inline: true },
            { name: 'Typ', value: typ, inline: true },
            { name: 'Channel', value: `<#${channel.id}>`, inline: true },
            { name: 'Intervall', value: `${intervall}s`, inline: true },
            { name: 'ID', value: `\`${feedId}\``, inline: false },
          )
          .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
        break;
      }

      case 'liste': {
        const feeds = await prisma.feed.findMany({
          orderBy: { createdAt: 'desc' },
        });

        if (feeds.length === 0) {
          await interaction.editReply({ content: '📡 Keine Feeds konfiguriert.' });
          return;
        }

        const typeEmoji: Record<string, string> = {
          RSS: '📰', TWITCH: '🟣', TWITTER: '🐦', STEAM: '🎮', NEWS: '📰', WEBHOOK: '🔗', CUSTOM: '⚙️',
        };

        const lines = feeds.map((f: any, i: number) => {
          const status = f.isActive ? '🟢' : '🔴';
          const emoji = typeEmoji[f.feedType] || '📡';
          const lastCheck = f.lastChecked ? f.lastChecked.toLocaleString('de-DE') : 'Nie';
          return `${status} ${emoji} **${f.name}** (${f.feedType})\n` +
            `   Channel: <#${f.channelId}> | Intervall: ${f.interval}s\n` +
            `   Letzte Prüfung: ${lastCheck}\n` +
            `   ID: \`${f.id}\``;
        });

        const embed = new EmbedBuilder()
          .setTitle('📡 Feeds')
          .setDescription(lines.join('\n\n'))
          .setColor(0x3498db)
          .setFooter({ text: `${feeds.length} Feeds konfiguriert` })
          .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
        break;
      }

      case 'loeschen': {
        const feedId = interaction.options.getString('feed-id', true);
        const feed = await prisma.feed.findUnique({ where: { id: feedId } });
        if (!feed) {
          await interaction.editReply({ content: '❌ Feed nicht gefunden.' });
          return;
        }
        await prisma.feed.delete({ where: { id: feedId } });
        logAudit('FEED_DELETED', 'FEED', { feedId, name: feed.name, adminId: interaction.user.id });
        await interaction.editReply({ content: `🗑️ Feed **${feed.name}** gelöscht.` });
        break;
      }

      case 'toggle': {
        const feedId = interaction.options.getString('feed-id', true);
        const feed = await prisma.feed.findUnique({ where: { id: feedId } });
        if (!feed) {
          await interaction.editReply({ content: '❌ Feed nicht gefunden.' });
          return;
        }
        const newState = !feed.isActive;
        await prisma.feed.update({ where: { id: feedId }, data: { isActive: newState } });
        await interaction.editReply({ content: `${newState ? '✅ Aktiviert' : '🔴 Deaktiviert'}: Feed **${feed.name}**` });
        break;
      }

      case 'abonnieren': {
        const feedId = interaction.options.getString('feed-id', true);
        const feed = await prisma.feed.findUnique({ where: { id: feedId } });
        if (!feed) {
          await interaction.editReply({ content: '❌ Feed nicht gefunden.' });
          return;
        }

        const dbUser = await prisma.user.upsert({
          where: { discordId: interaction.user.id },
          create: { discordId: interaction.user.id, username: interaction.user.username },
          update: {},
        });

        await prisma.feedSubscription.upsert({
          where: { feedId_userId: { feedId, userId: dbUser.id } },
          create: { feedId, userId: dbUser.id, notifyDm: true },
          update: { notifyDm: true },
        });

        await interaction.editReply({ content: `🔔 Du erhältst jetzt DM-Benachrichtigungen für **${feed.name}**.` });
        break;
      }
    }
  },
};

export default feedCommand;
