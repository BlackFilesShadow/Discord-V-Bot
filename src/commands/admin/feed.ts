import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
} from 'discord.js';
import { Command } from '../../types';
import prisma from '../../database/prisma';
import { createFeed } from '../../modules/feeds/feedManager';
import { generateWebhookSecret } from '../../modules/feeds/webhookReceiver';
import { config } from '../../config';
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
    case 'NEWS': {
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
    case 'WEBHOOK': {
      // Bei WEBHOOK ist die "URL" nur ein Quelltext/Label fuer den Webhook-Sender.
      // Wir akzeptieren beliebige Bezeichner (z.B. 'github-prod', 'grafana').
      if (trimmed.length > 200) return { ok: false, reason: 'Label/Quelle max 200 Zeichen.' };
      return { ok: true };
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
    .addSubcommand(sub =>
      sub
        .setName('rolle-add')
        .setDescription('Rolle hinzufuegen, die bei jedem neuen Feed-Eintrag gepingt wird')
        .addStringOption(opt => opt.setName('feed-id').setDescription('Feed-ID').setRequired(true))
        .addRoleOption(opt => opt.setName('rolle').setDescription('Zu pingende Rolle').setRequired(true)),
    )
    .addSubcommand(sub =>
      sub
        .setName('rolle-remove')
        .setDescription('Rolle aus Feed-Pings entfernen')
        .addStringOption(opt => opt.setName('feed-id').setDescription('Feed-ID').setRequired(true))
        .addRoleOption(opt => opt.setName('rolle').setDescription('Rolle').setRequired(true)),
    )
    .addSubcommand(sub =>
      sub
        .setName('rolle-list')
        .setDescription('Alle gepingten Rollen eines Feeds anzeigen')
        .addStringOption(opt => opt.setName('feed-id').setDescription('Feed-ID').setRequired(true)),
    )
    .addSubcommand(sub =>
      sub
        .setName('webhook-info')
        .setDescription('Webhook-URL + Secret eines WEBHOOK-Feeds anzeigen (ephemeral)')
        .addStringOption(opt => opt.setName('feed-id').setDescription('Feed-ID').setRequired(true)),
    )
    .addSubcommand(sub =>
      sub
        .setName('webhook-rotate')
        .setDescription('Neues Webhook-Secret generieren (altes wird sofort ungueltig)')
        .addStringOption(opt => opt.setName('feed-id').setDescription('Feed-ID').setRequired(true)),
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

        // Bei WEBHOOK-Typ direkt ein Secret generieren.
        let webhookSecret: string | null = null;
        if (typ === 'WEBHOOK') {
          webhookSecret = generateWebhookSecret();
          await prisma.feed.update({ where: { id: feedId }, data: { webhookSecret } });
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
        if (webhookSecret) {
          const base = (config.dashboard?.url || '').replace(/\/$/, '');
          const wurl = base ? `${base}/webhooks/feed/${feedId}` : `/webhooks/feed/${feedId}`;
          embed.addFields(
            { name: 'Webhook URL', value: '```' + wurl + '```' },
            { name: 'Secret', value: '```' + webhookSecret + '```' },
            { name: 'Hinweis', value: 'Details: `/feed webhook-info`. Rotation: `/feed webhook-rotate`.' },
          );
        }

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

      case 'rolle-add': {
        const feedId = interaction.options.getString('feed-id', true);
        const role = interaction.options.getRole('rolle', true);
        const feed = await prisma.feed.findUnique({ where: { id: feedId } });
        if (!feed) { await interaction.editReply({ content: '❌ Feed nicht gefunden.' }); return; }
        const current = new Set(feed.mentionRoles ?? []);
        current.add(role.id);
        await prisma.feed.update({ where: { id: feedId }, data: { mentionRoles: Array.from(current) } });
        logAudit('FEED_ROLE_ADDED', 'FEED', { feedId, roleId: role.id, by: interaction.user.id });
        await interaction.editReply({ content: `✅ Rolle <@&${role.id}> wird ab jetzt bei neuen Eintraegen von **${feed.name}** gepingt.` });
        break;
      }

      case 'rolle-remove': {
        const feedId = interaction.options.getString('feed-id', true);
        const role = interaction.options.getRole('rolle', true);
        const feed = await prisma.feed.findUnique({ where: { id: feedId } });
        if (!feed) { await interaction.editReply({ content: '❌ Feed nicht gefunden.' }); return; }
        const next = (feed.mentionRoles ?? []).filter((id) => id !== role.id);
        await prisma.feed.update({ where: { id: feedId }, data: { mentionRoles: next } });
        logAudit('FEED_ROLE_REMOVED', 'FEED', { feedId, roleId: role.id, by: interaction.user.id });
        await interaction.editReply({ content: `🗑️ Rolle <@&${role.id}> entfernt.` });
        break;
      }

      case 'rolle-list': {
        const feedId = interaction.options.getString('feed-id', true);
        const feed = await prisma.feed.findUnique({ where: { id: feedId } });
        if (!feed) { await interaction.editReply({ content: '❌ Feed nicht gefunden.' }); return; }
        const ids = feed.mentionRoles ?? [];
        await interaction.editReply({
          content: ids.length
            ? `📣 Pings bei **${feed.name}**: ${ids.map((id) => `<@&${id}>`).join(' ')}`
            : `Keine Rollen-Pings konfiguriert fuer **${feed.name}**.`,
        });
        break;
      }

      case 'webhook-info': {
        const feedId = interaction.options.getString('feed-id', true);
        const feed = await prisma.feed.findUnique({ where: { id: feedId } });
        if (!feed) { await interaction.editReply({ content: '❌ Feed nicht gefunden.' }); return; }
        if (feed.feedType !== 'WEBHOOK') {
          await interaction.editReply({ content: 'Dieser Feed ist kein WEBHOOK-Typ.' });
          return;
        }
        if (!feed.webhookSecret) {
          await interaction.editReply({ content: 'Noch kein Secret. Erst `/feed webhook-rotate` ausfuehren.' });
          return;
        }
        const base = (config.dashboard?.url || '').replace(/\/$/, '');
        const url = base ? `${base}/webhooks/feed/${feed.id}` : `/webhooks/feed/${feed.id}`;
        const embed = new EmbedBuilder()
          .setTitle('🔗 Webhook-Endpoint')
          .setColor(0x3498db)
          .addFields(
            { name: 'POST URL', value: '```' + url + '```' },
            { name: 'Secret', value: '```' + feed.webhookSecret + '```' },
            { name: 'HMAC-Header (empfohlen)', value: '```X-V-Webhook-Signature: sha256=<hex hmac sha256(secret, body)>```' },
            { name: 'Token-Header (Fallback)', value: '```X-V-Webhook-Token: <secret>```' },
            { name: 'Body (JSON)', value: '```{ "title": "...", "description": "...", "url": "https://...", "image": "https://...", "color": 3447003 }```' },
          )
          .setFooter({ text: 'Secret nicht teilen. Bei Verdacht: webhook-rotate.' });
        await interaction.editReply({ embeds: [embed] });
        break;
      }

      case 'webhook-rotate': {
        const feedId = interaction.options.getString('feed-id', true);
        const feed = await prisma.feed.findUnique({ where: { id: feedId } });
        if (!feed) { await interaction.editReply({ content: '❌ Feed nicht gefunden.' }); return; }
        if (feed.feedType !== 'WEBHOOK') {
          await interaction.editReply({ content: 'Dieser Feed ist kein WEBHOOK-Typ.' });
          return;
        }
        const secret = generateWebhookSecret();
        await prisma.feed.update({ where: { id: feedId }, data: { webhookSecret: secret } });
        logAudit('FEED_WEBHOOK_SECRET_ROTATED', 'FEED', { feedId, by: interaction.user.id });
        await interaction.editReply({ content: `🔁 Neues Secret generiert. Anzeigen mit \`/feed webhook-info feed-id:${feedId}\`.` });
        break;
      }
    }
  },
};

export default feedCommand;
