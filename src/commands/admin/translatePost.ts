import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  ChannelType,
  TextChannel,
  NewsChannel,
  ThreadChannel,
} from 'discord.js';
import { Command } from '../../types';
import { Colors, vEmbed } from '../../utils/embedDesign';
import { config } from '../../config';
import prisma from '../../database/prisma';
import { logger } from '../../utils/logger';
import { SUPPORTED_LANGUAGES, LANGUAGE_CODES, getLanguageName, translate } from '../../modules/ai/translator';
import { nextRunFromRecurrence, parseRecurrence } from '../../modules/ai/translatedPostScheduler';

/**
 * Phase 17: /translate-post
 *
 * Subcommands:
 *   - now        Sofort uebersetzen + posten
 *   - schedule   Einmalig zu festem Zeitpunkt posten
 *   - recurring  Wiederkehrend (DAILY:HH:MM oder WEEKLY:DAY:HH:MM) posten
 *   - list       Aktive Posts auflisten
 *   - delete     Geplanten Post deaktivieren
 */

async function isAdminOrOwner(discordId: string): Promise<boolean> {
  if (config.discord.ownerId && config.discord.ownerId === discordId) return true;
  const u = await prisma.user.findUnique({ where: { discordId }, select: { role: true } });
  if (!u) return false;
  return ['ADMIN', 'SUPER_ADMIN', 'DEVELOPER'].includes(u.role);
}

function languageChoices() {
  return SUPPORTED_LANGUAGES.map((l) => ({ name: `${l.emoji} ${l.name}`, value: l.code }));
}

/** Akzeptiert ISO `2026-04-25T14:30` oder deutsches `25.04.2026 14:30`. */
function parseScheduledDate(input: string): Date | null {
  // ISO direkt versuchen.
  const iso = new Date(input);
  if (!Number.isNaN(iso.getTime())) return iso;
  // DD.MM.YYYY HH:MM
  const m = input.trim().match(/^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [, dd, mm, yyyy, hh, mi] = m;
  // Eingabe ist Berlin-lokal -> UTC umrechnen
  const berlinFmt = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', timeZoneName: 'shortOffset' });
  const offsetPart = berlinFmt.formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT+1';
  const offMatch = offsetPart.match(/([+-]?\d{1,2})/);
  const offsetH = offMatch ? Number(offMatch[1]) : 1;
  const utcMs = Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd), Number(hh), Number(mi), 0) - offsetH * 3_600_000;
  const d = new Date(utcMs);
  return Number.isNaN(d.getTime()) ? null : d;
}

function fmtDate(d: Date | null | undefined): string {
  if (!d) return '-';
  return new Intl.DateTimeFormat('de-DE', {
    day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit',
    timeZone: 'Europe/Berlin',
  }).format(d);
}

function pad(n: number): string { return String(n).padStart(2, '0'); }

function buildRolePings(interaction: ChatInputCommandInteraction): string | null {
  const ids: string[] = [];
  for (const k of ['rolle1', 'rolle2', 'rolle3'] as const) {
    const r = interaction.options.getRole(k);
    if (r) ids.push(r.id);
  }
  return ids.length ? ids.join(',') : null;
}

const translatePostCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('translate-post')
    .setDescription('Auto-Uebersetzen + Posten in einem Channel (10 Sprachen)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) =>
      sub
        .setName('now')
        .setDescription('Sofort uebersetzen und posten')
        .addStringOption((o) => o.setName('text').setDescription('Originaltext').setRequired(true).setMaxLength(3500))
        .addStringOption((o) => o.setName('zielsprache').setDescription('Zielsprache').setRequired(true).addChoices(...languageChoices()))
        .addChannelOption((o) => o.setName('channel').setDescription('Zielchannel').setRequired(true).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
        .addStringOption((o) => o.setName('quellsprache').setDescription('Quellsprache (Auto-Detect wenn leer)').addChoices(...languageChoices()))
        .addAttachmentOption((o) => o.setName('bild').setDescription('Optionales Bild'))
        .addRoleOption((o) => o.setName('rolle1').setDescription('Rolle 1 anpingen'))
        .addRoleOption((o) => o.setName('rolle2').setDescription('Rolle 2 anpingen'))
        .addRoleOption((o) => o.setName('rolle3').setDescription('Rolle 3 anpingen')),
    )
    .addSubcommand((sub) =>
      sub
        .setName('schedule')
        .setDescription('Einmalig zu festem Zeitpunkt posten')
        .addStringOption((o) => o.setName('text').setDescription('Originaltext').setRequired(true).setMaxLength(3500))
        .addStringOption((o) => o.setName('zielsprache').setDescription('Zielsprache').setRequired(true).addChoices(...languageChoices()))
        .addChannelOption((o) => o.setName('channel').setDescription('Zielchannel').setRequired(true).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
        .addStringOption((o) => o.setName('zeitpunkt').setDescription('ISO 2026-04-25T14:30 oder DD.MM.YYYY HH:MM (Europe/Berlin)').setRequired(true))
        .addStringOption((o) => o.setName('quellsprache').setDescription('Quellsprache (Auto-Detect wenn leer)').addChoices(...languageChoices()))
        .addAttachmentOption((o) => o.setName('bild').setDescription('Optionales Bild'))
        .addRoleOption((o) => o.setName('rolle1').setDescription('Rolle 1 anpingen'))
        .addRoleOption((o) => o.setName('rolle2').setDescription('Rolle 2 anpingen'))
        .addRoleOption((o) => o.setName('rolle3').setDescription('Rolle 3 anpingen')),
    )
    .addSubcommand((sub) =>
      sub
        .setName('recurring')
        .setDescription('Wiederkehrend posten (Profi: HOURLY:MM | DAILY:HH:MM | WEEKLY:DAY:HH:MM | MONTHLY:DD:HH:MM)')
        .addStringOption((o) => o.setName('text').setDescription('Originaltext').setRequired(true).setMaxLength(3500))
        .addStringOption((o) => o.setName('zielsprache').setDescription('Zielsprache').setRequired(true).addChoices(...languageChoices()))
        .addChannelOption((o) => o.setName('channel').setDescription('Zielchannel').setRequired(true).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
        .addStringOption((o) => o.setName('cron').setDescription('z.B. DAILY:09:00, WEEKLY:MON:18:30, MONTHLY:23:11:45, HOURLY:15').setRequired(true))
        .addStringOption((o) => o.setName('quellsprache').setDescription('Quellsprache (Auto-Detect wenn leer)').addChoices(...languageChoices()))
        .addAttachmentOption((o) => o.setName('bild').setDescription('Optionales Bild'))
        .addRoleOption((o) => o.setName('rolle1').setDescription('Rolle 1 anpingen'))
        .addRoleOption((o) => o.setName('rolle2').setDescription('Rolle 2 anpingen'))
        .addRoleOption((o) => o.setName('rolle3').setDescription('Rolle 3 anpingen')),
    )
    .addSubcommand((sub) =>
      sub
        .setName('stuendlich')
        .setDescription('Jede Stunde zur gewaehlten Minute posten')
        .addStringOption((o) => o.setName('text').setDescription('Originaltext').setRequired(true).setMaxLength(3500))
        .addStringOption((o) => o.setName('zielsprache').setDescription('Zielsprache').setRequired(true).addChoices(...languageChoices()))
        .addChannelOption((o) => o.setName('channel').setDescription('Zielchannel').setRequired(true).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
        .addIntegerOption((o) => o.setName('minute').setDescription('Minute (0-59)').setRequired(true).setMinValue(0).setMaxValue(59))
        .addStringOption((o) => o.setName('quellsprache').setDescription('Quellsprache').addChoices(...languageChoices()))
        .addAttachmentOption((o) => o.setName('bild').setDescription('Optionales Bild'))
        .addRoleOption((o) => o.setName('rolle1').setDescription('Rolle 1 anpingen'))
        .addRoleOption((o) => o.setName('rolle2').setDescription('Rolle 2 anpingen'))
        .addRoleOption((o) => o.setName('rolle3').setDescription('Rolle 3 anpingen')),
    )
    .addSubcommand((sub) =>
      sub
        .setName('taeglich')
        .setDescription('Jeden Tag zur gewaehlten Uhrzeit posten')
        .addStringOption((o) => o.setName('text').setDescription('Originaltext').setRequired(true).setMaxLength(3500))
        .addStringOption((o) => o.setName('zielsprache').setDescription('Zielsprache').setRequired(true).addChoices(...languageChoices()))
        .addChannelOption((o) => o.setName('channel').setDescription('Zielchannel').setRequired(true).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
        .addIntegerOption((o) => o.setName('stunde').setDescription('Stunde (0-23)').setRequired(true).setMinValue(0).setMaxValue(23))
        .addIntegerOption((o) => o.setName('minute').setDescription('Minute (0-59)').setRequired(true).setMinValue(0).setMaxValue(59))
        .addStringOption((o) => o.setName('quellsprache').setDescription('Quellsprache').addChoices(...languageChoices()))
        .addAttachmentOption((o) => o.setName('bild').setDescription('Optionales Bild'))
        .addRoleOption((o) => o.setName('rolle1').setDescription('Rolle 1 anpingen'))
        .addRoleOption((o) => o.setName('rolle2').setDescription('Rolle 2 anpingen'))
        .addRoleOption((o) => o.setName('rolle3').setDescription('Rolle 3 anpingen')),
    )
    .addSubcommand((sub) =>
      sub
        .setName('woechentlich')
        .setDescription('Jede Woche an festem Wochentag und Uhrzeit posten')
        .addStringOption((o) => o.setName('text').setDescription('Originaltext').setRequired(true).setMaxLength(3500))
        .addStringOption((o) => o.setName('zielsprache').setDescription('Zielsprache').setRequired(true).addChoices(...languageChoices()))
        .addChannelOption((o) => o.setName('channel').setDescription('Zielchannel').setRequired(true).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
        .addStringOption((o) => o.setName('wochentag').setDescription('Wochentag').setRequired(true).addChoices(
          { name: 'Montag', value: 'MON' }, { name: 'Dienstag', value: 'TUE' }, { name: 'Mittwoch', value: 'WED' },
          { name: 'Donnerstag', value: 'THU' }, { name: 'Freitag', value: 'FRI' }, { name: 'Samstag', value: 'SAT' }, { name: 'Sonntag', value: 'SUN' },
        ))
        .addIntegerOption((o) => o.setName('stunde').setDescription('Stunde (0-23)').setRequired(true).setMinValue(0).setMaxValue(23))
        .addIntegerOption((o) => o.setName('minute').setDescription('Minute (0-59)').setRequired(true).setMinValue(0).setMaxValue(59))
        .addStringOption((o) => o.setName('quellsprache').setDescription('Quellsprache').addChoices(...languageChoices()))
        .addAttachmentOption((o) => o.setName('bild').setDescription('Optionales Bild'))
        .addRoleOption((o) => o.setName('rolle1').setDescription('Rolle 1 anpingen'))
        .addRoleOption((o) => o.setName('rolle2').setDescription('Rolle 2 anpingen'))
        .addRoleOption((o) => o.setName('rolle3').setDescription('Rolle 3 anpingen')),
    )
    .addSubcommand((sub) =>
      sub
        .setName('monatlich')
        .setDescription('Jeden Monat an festem Tag und Uhrzeit posten (z.B. 23. um 11:45)')
        .addStringOption((o) => o.setName('text').setDescription('Originaltext').setRequired(true).setMaxLength(3500))
        .addStringOption((o) => o.setName('zielsprache').setDescription('Zielsprache').setRequired(true).addChoices(...languageChoices()))
        .addChannelOption((o) => o.setName('channel').setDescription('Zielchannel').setRequired(true).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
        .addIntegerOption((o) => o.setName('tag').setDescription('Tag im Monat (1-31)').setRequired(true).setMinValue(1).setMaxValue(31))
        .addIntegerOption((o) => o.setName('stunde').setDescription('Stunde (0-23)').setRequired(true).setMinValue(0).setMaxValue(23))
        .addIntegerOption((o) => o.setName('minute').setDescription('Minute (0-59)').setRequired(true).setMinValue(0).setMaxValue(59))
        .addStringOption((o) => o.setName('quellsprache').setDescription('Quellsprache').addChoices(...languageChoices()))
        .addAttachmentOption((o) => o.setName('bild').setDescription('Optionales Bild'))
        .addRoleOption((o) => o.setName('rolle1').setDescription('Rolle 1 anpingen'))
        .addRoleOption((o) => o.setName('rolle2').setDescription('Rolle 2 anpingen'))
        .addRoleOption((o) => o.setName('rolle3').setDescription('Rolle 3 anpingen')),
    )
    .addSubcommand((sub) => sub.setName('list').setDescription('Aktive geplante Posts dieser Guild auflisten'))
    .addSubcommand((sub) =>
      sub
        .setName('delete')
        .setDescription('Geplanten Post deaktivieren')
        .addStringOption((o) => o.setName('id').setDescription('Post-ID (siehe /translate-post list)').setRequired(true)),
    ) as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction) {
    if (!interaction.guild) {
      await interaction.reply({ content: 'Nur in Guilds verwendbar.', ephemeral: true });
      return;
    }
    if (!(await isAdminOrOwner(interaction.user.id))) {
      await interaction.reply({ content: 'Keine Berechtigung.', ephemeral: true });
      return;
    }
    const sub = interaction.options.getSubcommand();
    try {
      if (sub === 'list') return await handleList(interaction);
      if (sub === 'delete') return await handleDelete(interaction);
      if (sub === 'now') return await handleNow(interaction);
      if (sub === 'schedule') return await handleSchedule(interaction);
      if (sub === 'recurring') return await handleRecurring(interaction, interaction.options.getString('cron', true));
      if (sub === 'stuendlich') {
        const m = interaction.options.getInteger('minute', true);
        return await handleRecurring(interaction, `HOURLY:${pad(m)}`);
      }
      if (sub === 'taeglich') {
        const h = interaction.options.getInteger('stunde', true);
        const m = interaction.options.getInteger('minute', true);
        return await handleRecurring(interaction, `DAILY:${pad(h)}:${pad(m)}`);
      }
      if (sub === 'woechentlich') {
        const wd = interaction.options.getString('wochentag', true);
        const h = interaction.options.getInteger('stunde', true);
        const m = interaction.options.getInteger('minute', true);
        return await handleRecurring(interaction, `WEEKLY:${wd}:${pad(h)}:${pad(m)}`);
      }
      if (sub === 'monatlich') {
        const d = interaction.options.getInteger('tag', true);
        const h = interaction.options.getInteger('stunde', true);
        const m = interaction.options.getInteger('minute', true);
        return await handleRecurring(interaction, `MONTHLY:${pad(d)}:${pad(h)}:${pad(m)}`);
      }
    } catch (e) {
      logger.error('translate-post fehlgeschlagen:', e as Error);
      const msg = `Fehler: ${String((e as Error)?.message ?? e)}`;
      if (interaction.deferred || interaction.replied) await interaction.editReply(msg);
      else await interaction.reply({ content: msg, ephemeral: true });
    }
  },
};

async function handleNow(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  const text = interaction.options.getString('text', true);
  const target = interaction.options.getString('zielsprache', true);
  const source = interaction.options.getString('quellsprache') ?? undefined;
  const channel = interaction.options.getChannel('channel', true);
  const image = interaction.options.getAttachment('bild');
  const rolePings = buildRolePings(interaction);

  if (!LANGUAGE_CODES.includes(target)) throw new Error(`Unbekannte Zielsprache: ${target}`);
  if (source && !LANGUAGE_CODES.includes(source)) throw new Error(`Unbekannte Quellsprache: ${source}`);

  const translated = await translate(text, target, source);
  if (!translated) throw new Error('Uebersetzung fehlgeschlagen (alle Provider).');

  // DB-Eintrag mit translatedText vorbefuellen + sofort senden.
  const post = await prisma.translatedPost.create({
    data: {
      guildId: interaction.guildId!,
      channelId: channel.id,
      createdBy: interaction.user.id,
      sourceText: text,
      sourceLang: source ?? 'auto',
      targetLang: target,
      translatedText: translated,
      imageUrl: image?.url ?? null,
      rolePings,
      mode: 'now',
      nextRunAt: new Date(),
      isActive: true,
    },
  });
  // Senden via Channel-Fetch.
  const ch = await interaction.client.channels.fetch(channel.id);
  if (!ch || !('send' in ch)) throw new Error('Channel nicht erreichbar.');
  const allowedRoleIds = (rolePings ?? '').split(',').filter(Boolean);
  const pingPrefix = allowedRoleIds.map((id) => `<@&${id}>`).join(' ');
  const content = pingPrefix ? `${pingPrefix}\n${translated}` : translated;
  await (ch as TextChannel | NewsChannel | ThreadChannel).send({
    content,
    ...(image ? { files: [{ attachment: image.url }] } : {}),
    allowedMentions: { roles: allowedRoleIds, parse: [] },
  });
  await prisma.translatedPost.update({ where: { id: post.id }, data: { lastRunAt: new Date(), isActive: false } });

  await interaction.editReply({
    embeds: [vEmbed(Colors.Success)
      .setTitle('Post gesendet')
      .setDescription(`Sprache: **${getLanguageName(target)}**\nChannel: <#${channel.id}>\nID: \`${post.id}\``)],
  });
}

async function handleSchedule(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  const text = interaction.options.getString('text', true);
  const target = interaction.options.getString('zielsprache', true);
  const source = interaction.options.getString('quellsprache') ?? undefined;
  const channel = interaction.options.getChannel('channel', true);
  const image = interaction.options.getAttachment('bild');
  const when = interaction.options.getString('zeitpunkt', true);
  const rolePings = buildRolePings(interaction);

  if (!LANGUAGE_CODES.includes(target)) throw new Error(`Unbekannte Zielsprache: ${target}`);
  const date = parseScheduledDate(when);
  if (!date) throw new Error('Zeitpunkt ungueltig (ISO 2026-04-25T14:30 oder DD.MM.YYYY HH:MM).');
  if (date.getTime() < Date.now() - 60_000) throw new Error('Zeitpunkt liegt in der Vergangenheit.');

  const post = await prisma.translatedPost.create({
    data: {
      guildId: interaction.guildId!,
      channelId: channel.id,
      createdBy: interaction.user.id,
      sourceText: text,
      sourceLang: source ?? 'auto',
      targetLang: target,
      imageUrl: image?.url ?? null,
      rolePings,
      mode: 'once',
      scheduledFor: date,
      nextRunAt: date,
      isActive: true,
    },
  });
  await interaction.editReply({
    embeds: [vEmbed(Colors.Info)
      .setTitle('Post geplant')
      .setDescription([
        `Sprache: **${getLanguageName(target)}**`,
        `Channel: <#${channel.id}>`,
        `Zeitpunkt: **${fmtDate(date)}** (Europe/Berlin)`,
        `ID: \`${post.id}\``,
      ].join('\n'))],
  });
}

async function handleRecurring(interaction: ChatInputCommandInteraction, cron: string): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  const text = interaction.options.getString('text', true);
  const target = interaction.options.getString('zielsprache', true);
  const source = interaction.options.getString('quellsprache') ?? undefined;
  const channel = interaction.options.getChannel('channel', true);
  const image = interaction.options.getAttachment('bild');
  const rolePings = buildRolePings(interaction);

  if (!LANGUAGE_CODES.includes(target)) throw new Error(`Unbekannte Zielsprache: ${target}`);
  if (!parseRecurrence(cron)) throw new Error('Cron ungueltig. Format: HOURLY:MM | DAILY:HH:MM | WEEKLY:DAY:HH:MM | MONTHLY:DD:HH:MM.');
  const next = nextRunFromRecurrence(cron);
  if (!next) throw new Error('Konnte naechsten Ausfuehrungszeitpunkt nicht berechnen.');

  const post = await prisma.translatedPost.create({
    data: {
      guildId: interaction.guildId!,
      channelId: channel.id,
      createdBy: interaction.user.id,
      sourceText: text,
      sourceLang: source ?? 'auto',
      targetLang: target,
      imageUrl: image?.url ?? null,
      rolePings,
      mode: 'recurring',
      recurrenceCron: cron.toUpperCase(),
      nextRunAt: next,
      isActive: true,
    },
  });
  await interaction.editReply({
    embeds: [vEmbed(Colors.Info)
      .setTitle('Wiederkehrender Post angelegt')
      .setDescription([
        `Sprache: **${getLanguageName(target)}**`,
        `Channel: <#${channel.id}>`,
        `Cron: \`${cron.toUpperCase()}\``,
        `Naechster Lauf: **${fmtDate(next)}** (Europe/Berlin)`,
        `ID: \`${post.id}\``,
      ].join('\n'))],
  });
}

async function handleList(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  const posts = await prisma.translatedPost.findMany({
    where: { guildId: interaction.guildId!, isActive: true },
    orderBy: { nextRunAt: 'asc' },
    take: 25,
  });
  if (posts.length === 0) {
    await interaction.editReply({ embeds: [vEmbed(Colors.Info).setTitle('Keine aktiven Posts')] });
    return;
  }
  const lines = posts.map((p) => {
    const langs = `${p.sourceLang}->${p.targetLang}`;
    const meta = p.mode === 'recurring' ? `cron=${p.recurrenceCron}` : `at=${fmtDate(p.nextRunAt)}`;
    const preview = p.sourceText.slice(0, 50).replace(/\n/g, ' ');
    return `\`${p.id.slice(0, 8)}\` | <#${p.channelId}> | ${langs} | ${p.mode} | ${meta}\n  > ${preview}${p.sourceText.length > 50 ? '...' : ''}`;
  });
  await interaction.editReply({
    embeds: [vEmbed(Colors.Info).setTitle(`Aktive Posts (${posts.length})`).setDescription(lines.join('\n').slice(0, 4000))],
  });
}

async function handleDelete(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  const id = interaction.options.getString('id', true).trim();
  // Erlaube Praefix-Match auf die ersten 8 Zeichen.
  const post = await prisma.translatedPost.findFirst({
    where: { guildId: interaction.guildId!, OR: [{ id }, { id: { startsWith: id } }] },
  });
  if (!post) {
    await interaction.editReply({ content: `Kein Post mit ID \`${id}\` in dieser Guild gefunden.` });
    return;
  }
  await prisma.translatedPost.update({ where: { id: post.id }, data: { isActive: false } });
  await interaction.editReply({
    embeds: [vEmbed(Colors.Success).setTitle('Post deaktiviert').setDescription(`ID: \`${post.id}\``)],
  });
}

export default translatePostCommand;
