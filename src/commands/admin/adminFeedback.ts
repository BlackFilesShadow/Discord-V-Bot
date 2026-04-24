import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  ChannelType,
  TextChannel,
} from 'discord.js';
import { Command } from '../../types';
import prisma from '../../database/prisma';
import { Prisma } from '@prisma/client';
import { Colors, vEmbed } from '../../utils/embedDesign';
import { config } from '../../config';
import { logger, logAudit } from '../../utils/logger';

/**
 * /admin-feedback — Verwaltung der via /feedback eingereichten Eintraege.
 *
 * Subcommands:
 *   - liste     Letzte 25 Feedbacks (optional Status-Filter)
 *   - zeigen    Detailansicht einer ID
 *   - status    Status setzen (OPEN | IN_REVIEW | RESOLVED | WONTFIX)
 *   - notiz     Admin-Notiz an einem Feedback ablegen
 *   - channel   Discord-Channel fuer Echtzeit-Notifications setzen/entfernen
 */

const STATUS_VALUES = ['OPEN', 'IN_REVIEW', 'RESOLVED', 'WONTFIX'] as const;
type StatusValue = typeof STATUS_VALUES[number];

const STATUS_COLORS: Record<StatusValue, number> = {
  OPEN: Colors.Warning,
  IN_REVIEW: Colors.Info,
  RESOLVED: Colors.Success,
  WONTFIX: Colors.Neutral,
};

const CATEGORY_LABEL: Record<string, string> = {
  BUG: '🐛 Bug',
  IDEA: '💡 Idee',
  PRAISE: '🌟 Lob',
  OTHER: '📩 Sonstiges',
};

function fmtDate(d: Date | null | undefined): string {
  if (!d) return '-';
  return new Intl.DateTimeFormat('de-DE', {
    day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit',
    timeZone: 'Europe/Berlin',
  }).format(d);
}

const adminFeedbackCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('admin-feedback')
    .setDescription('Verwaltung der via /feedback eingereichten Eintraege')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) =>
      sub
        .setName('liste')
        .setDescription('Letzte Feedbacks dieser Guild')
        .addStringOption((o) =>
          o.setName('status').setDescription('Optional: nach Status filtern')
            .addChoices(
              { name: 'Offen', value: 'OPEN' },
              { name: 'In Pruefung', value: 'IN_REVIEW' },
              { name: 'Geloest', value: 'RESOLVED' },
              { name: 'Wird nicht behoben', value: 'WONTFIX' },
            ),
        )
        .addStringOption((o) =>
          o.setName('kategorie').setDescription('Optional: nach Kategorie filtern')
            .addChoices(
              { name: 'Bug', value: 'BUG' },
              { name: 'Idee', value: 'IDEA' },
              { name: 'Lob', value: 'PRAISE' },
              { name: 'Sonstiges', value: 'OTHER' },
            ),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('zeigen')
        .setDescription('Detailansicht einer Feedback-ID')
        .addStringOption((o) => o.setName('id').setDescription('Feedback-ID (auch 8-Zeichen-Praefix)').setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('status')
        .setDescription('Status eines Feedbacks setzen')
        .addStringOption((o) => o.setName('id').setDescription('Feedback-ID').setRequired(true))
        .addStringOption((o) =>
          o.setName('wert').setDescription('Neuer Status').setRequired(true)
            .addChoices(
              { name: 'Offen', value: 'OPEN' },
              { name: 'In Pruefung', value: 'IN_REVIEW' },
              { name: 'Geloest', value: 'RESOLVED' },
              { name: 'Wird nicht behoben', value: 'WONTFIX' },
            ),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('notiz')
        .setDescription('Admin-Notiz an einem Feedback ablegen')
        .addStringOption((o) => o.setName('id').setDescription('Feedback-ID').setRequired(true))
        .addStringOption((o) => o.setName('text').setDescription('Notiztext').setRequired(true).setMaxLength(1000)),
    )
    .addSubcommand((sub) =>
      sub
        .setName('channel')
        .setDescription('Discord-Channel fuer Echtzeit-Feedback-Posts setzen/entfernen')
        .addChannelOption((o) =>
          o.setName('channel').setDescription('Zielchannel (leer = entfernen)').addChannelTypes(
            ChannelType.GuildText, ChannelType.GuildAnnouncement,
          ),
        )
        .addStringOption((o) =>
          o.setName('scope').setDescription('guild = nur dieser Server, global = Owner-Fallback fuer alle Guilds')
            .addChoices(
              { name: 'Guild (nur dieser Server)', value: 'guild' },
              { name: 'Global (Owner-Fallback)', value: 'global' },
            ),
        ),
    ) as SlashCommandBuilder,
  adminOnly: true,

  async execute(interaction: ChatInputCommandInteraction) {
    const sub = interaction.options.getSubcommand();
    const ownerCall = !!config.discord.ownerId && interaction.user.id === config.discord.ownerId;
    // Owner darf alle Subcommands ohne Guild aufrufen (cross-guild Verwaltung).
    // Sonst: nur 'channel' (mit scope=global) ist ausserhalb einer Guild zulaessig.
    if (!interaction.guildId && !ownerCall && sub !== 'channel') {
      await interaction.reply({ content: 'Nur in Guilds verwendbar.', ephemeral: true });
      return;
    }
    try {
      if (sub === 'liste') return await handleListe(interaction);
      if (sub === 'zeigen') return await handleZeigen(interaction);
      if (sub === 'status') return await handleStatus(interaction);
      if (sub === 'notiz') return await handleNotiz(interaction);
      if (sub === 'channel') return await handleChannel(interaction);
    } catch (e) {
      logger.error('admin-feedback fehlgeschlagen:', e as Error);
      const msg = `Fehler: ${String((e as Error)?.message ?? e)}`;
      if (interaction.deferred || interaction.replied) await interaction.editReply(msg);
      else await interaction.reply({ content: msg, ephemeral: true });
    }
  },
};

function isOwner(interaction: ChatInputCommandInteraction): boolean {
  return !!config.discord.ownerId && interaction.user.id === config.discord.ownerId;
}

const CATEGORY_COLOR: Record<string, number> = {
  BUG: Colors.Error,
  IDEA: Colors.Info,
  PRAISE: Colors.Success,
  OTHER: Colors.Neutral,
};

/**
 * Aktualisiert die im urspruenglichen Notify-Channel gepostete Embed-Nachricht
 * (Status-Feld + Admin-Notiz). Stillschweigend, falls Channel/Message weg.
 */
async function refreshNotifyEmbed(
  interaction: ChatInputCommandInteraction,
  fb: { id: string; category: string; subject: string; message: string; userId: string; guildId: string | null; status: string; adminNote: string | null; reviewedBy: string | null; reviewedAt: Date | null; createdAt: Date; notifyChannelId: string | null; notifyMessageId: string | null; },
): Promise<void> {
  if (!fb.notifyChannelId || !fb.notifyMessageId) return;
  try {
    const ch = await interaction.client.channels.fetch(fb.notifyChannelId).catch(() => null);
    if (!ch || !ch.isTextBased()) return;
    const msg = await (ch as TextChannel).messages.fetch(fb.notifyMessageId).catch(() => null);
    if (!msg) return;
    const cat = CATEGORY_LABEL[fb.category] ?? fb.category;
    let serverField = 'DM';
    if (fb.guildId) {
      const g = interaction.client.guilds.cache.get(fb.guildId)
        ?? await interaction.client.guilds.fetch(fb.guildId).catch(() => null);
      serverField = g ? `**${g.name}**\n\`${fb.guildId}\`` : `\`${fb.guildId}\``;
    }
    const color = STATUS_COLORS[(fb.status as StatusValue)] ?? CATEGORY_COLOR[fb.category] ?? Colors.Info;
    const embed = vEmbed(color)
      .setTitle(`${cat} • ${fb.subject}`)
      .setDescription(fb.message.slice(0, 3500))
      .addFields(
        { name: 'Von', value: `<@${fb.userId}> (\`${fb.userId}\`)`, inline: true },
        { name: 'Server', value: serverField, inline: true },
        { name: 'Status', value: `\`${fb.status}\``, inline: true },
        { name: 'ID', value: `\`${fb.id}\``, inline: false },
      );
    if (fb.adminNote) embed.addFields({ name: 'Admin-Notiz', value: fb.adminNote.slice(0, 1024) });
    if (fb.reviewedBy) embed.addFields({ name: 'Bearbeitet von', value: `<@${fb.reviewedBy}> · ${fmtDate(fb.reviewedAt)}`, inline: true });
    await msg.edit({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => null);
  } catch (e) {
    logger.warn('refreshNotifyEmbed fehlgeschlagen:', e as Error);
  }
}

async function handleListe(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  const status = interaction.options.getString('status') ?? undefined;
  const category = interaction.options.getString('kategorie') ?? undefined;
  const owner = isOwner(interaction);
  const items = await prisma.feedback.findMany({
    where: {
      ...(owner ? {} : { guildId: interaction.guildId! }),
      ...(status ? { status } : {}),
      ...(category ? { category } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: 25,
  });
  if (items.length === 0) {
    await interaction.editReply({ embeds: [vEmbed(Colors.Info).setTitle('Keine Feedbacks gefunden')] });
    return;
  }
  // Guild-Namen aufloesen (Owner-Modus: cross-guild)
  const guildNames = new Map<string, string>();
  if (owner) {
    const ids = [...new Set(items.map((i) => i.guildId).filter((g): g is string => !!g))];
    for (const gid of ids) {
      const g = interaction.client.guilds.cache.get(gid)
        ?? await interaction.client.guilds.fetch(gid).catch(() => null);
      if (g) guildNames.set(gid, g.name);
    }
  }
  const lines = items.map((f) => {
    const cat = CATEGORY_LABEL[f.category] ?? f.category;
    const where = owner && f.guildId
      ? ` · _${guildNames.get(f.guildId) ?? f.guildId}_`
      : '';
    return `\`${f.id.slice(0, 8)}\` · ${cat} · **${f.status}** · ${fmtDate(f.createdAt)} · <@${f.userId}>${where}\n  > ${f.subject.slice(0, 80)}`;
  });
  await interaction.editReply({
    embeds: [vEmbed(Colors.Info)
      .setTitle(`Feedbacks (${items.length})${owner ? ' · alle Guilds' : ''}`)
      .setDescription(lines.join('\n').slice(0, 4000))
      .setFooter({ text: 'Detail: /admin-feedback zeigen id:<8-Zeichen>' })],
  });
}

async function findByPrefix(interaction: ChatInputCommandInteraction, idInput: string) {
  const owner = isOwner(interaction);
  return prisma.feedback.findFirst({
    where: {
      ...(owner ? {} : { guildId: interaction.guildId! }),
      OR: [{ id: idInput }, { id: { startsWith: idInput } }],
    },
  });
}

async function handleZeigen(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  const id = interaction.options.getString('id', true).trim();
  const fb = await findByPrefix(interaction, id);
  if (!fb) {
    await interaction.editReply({ content: `Kein Feedback mit ID \`${id}\` gefunden.` });
    return;
  }
  const cat = CATEGORY_LABEL[fb.category] ?? fb.category;
  let serverField = 'DM';
  if (fb.guildId) {
    const g = interaction.client.guilds.cache.get(fb.guildId)
      ?? await interaction.client.guilds.fetch(fb.guildId).catch(() => null);
    serverField = g ? `**${g.name}**\n\`${fb.guildId}\`` : `\`${fb.guildId}\``;
  }
  const embed = vEmbed(STATUS_COLORS[(fb.status as StatusValue)] ?? Colors.Info)
    .setTitle(`${cat} • ${fb.subject}`)
    .setDescription(fb.message.slice(0, 3500))
    .addFields(
      { name: 'Von', value: `<@${fb.userId}> (\`${fb.userId}\`)`, inline: true },
      { name: 'Server', value: serverField, inline: true },
      { name: 'Status', value: `\`${fb.status}\``, inline: true },
      { name: 'Erstellt', value: fmtDate(fb.createdAt), inline: true },
      { name: 'ID', value: `\`${fb.id}\``, inline: false },
    );
  if (fb.adminNote) embed.addFields({ name: 'Admin-Notiz', value: fb.adminNote.slice(0, 1024) });
  if (fb.reviewedBy) embed.addFields({ name: 'Bearbeitet von', value: `<@${fb.reviewedBy}> · ${fmtDate(fb.reviewedAt)}` });
  await interaction.editReply({ embeds: [embed] });
}

async function handleStatus(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  const id = interaction.options.getString('id', true).trim();
  const wert = interaction.options.getString('wert', true) as StatusValue;
  const fb = await findByPrefix(interaction, id);
  if (!fb) {
    await interaction.editReply({ content: `Kein Feedback mit ID \`${id}\` gefunden.` });
    return;
  }
  await prisma.feedback.update({
    where: { id: fb.id },
    data: { status: wert, reviewedBy: interaction.user.id, reviewedAt: new Date() },
  });
  logAudit('FEEDBACK_STATUS_CHANGED', 'ADMIN', { feedbackId: fb.id, from: fb.status, to: wert, by: interaction.user.id });
  // Original-Notify-Embed updaten (Farbe + Status + Notiz).
  const fresh = await prisma.feedback.findUnique({ where: { id: fb.id } });
  if (fresh) await refreshNotifyEmbed(interaction, fresh);
  await interaction.editReply({
    embeds: [vEmbed(STATUS_COLORS[wert]).setTitle('Status aktualisiert').setDescription(`\`${fb.id}\` → **${wert}**`)],
  });
}

async function handleNotiz(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  const id = interaction.options.getString('id', true).trim();
  const text = interaction.options.getString('text', true).trim();
  const fb = await findByPrefix(interaction, id);
  if (!fb) {
    await interaction.editReply({ content: `Kein Feedback mit ID \`${id}\` gefunden.` });
    return;
  }
  await prisma.feedback.update({
    where: { id: fb.id },
    data: { adminNote: text, reviewedBy: interaction.user.id, reviewedAt: new Date() },
  });
  logAudit('FEEDBACK_NOTE_SET', 'ADMIN', { feedbackId: fb.id, by: interaction.user.id });
  const fresh = await prisma.feedback.findUnique({ where: { id: fb.id } });
  if (fresh) await refreshNotifyEmbed(interaction, fresh);
  await interaction.editReply({
    embeds: [vEmbed(Colors.Success).setTitle('Notiz gespeichert').setDescription(`\`${fb.id}\``)],
  });
}

async function handleChannel(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  const channel = interaction.options.getChannel('channel') as TextChannel | null;
  const scope = (interaction.options.getString('scope') ?? 'guild') as 'guild' | 'global';

  if (scope === 'global') {
    // Nur Owner darf den globalen Fallback setzen.
    if (!config.discord.ownerId || interaction.user.id !== config.discord.ownerId) {
      await interaction.editReply({ content: 'Nur der Bot-Owner darf den globalen Feedback-Channel setzen.' });
      return;
    }
    await prisma.botConfig.upsert({
      where: { key: 'globalFeedbackChannelId' },
      create: {
        key: 'globalFeedbackChannelId',
        value: channel?.id ?? Prisma.JsonNull,
        category: 'feedback',
        description: 'Owner-Fallback-Channel: empfaengt /feedback aus Guilds ohne eigenen Channel.',
        updatedBy: interaction.user.id,
      },
      update: { value: channel?.id ?? Prisma.JsonNull, updatedBy: interaction.user.id },
    });
    logAudit('FEEDBACK_GLOBAL_CHANNEL_SET', 'ADMIN', { channelId: channel?.id ?? null, by: interaction.user.id });
    await interaction.editReply({
      embeds: [vEmbed(Colors.Success)
        .setTitle('Globaler Feedback-Channel aktualisiert')
        .setDescription(channel
          ? `/feedback aus Guilds ohne eigenen Channel landet jetzt in <#${channel.id}>.`
          : 'Globaler Fallback deaktiviert.')],
    });
    return;
  }

  if (!interaction.guildId) {
    await interaction.editReply({ content: 'Guild-Scope nur in Guilds verwendbar.' });
    return;
  }
  await prisma.guildProfile.upsert({
    where: { guildId: interaction.guildId },
    create: {
      guildId: interaction.guildId,
      name: interaction.guild?.name ?? 'unknown',
      feedbackChannelId: channel?.id ?? null,
    },
    update: { feedbackChannelId: channel?.id ?? null },
  });
  logAudit('FEEDBACK_CHANNEL_SET', 'ADMIN', { guildId: interaction.guildId, channelId: channel?.id ?? null, by: interaction.user.id });
  await interaction.editReply({
    embeds: [vEmbed(Colors.Success)
      .setTitle('Feedback-Channel aktualisiert')
      .setDescription(channel ? `Neue /feedback-Eintraege werden in <#${channel.id}> gespiegelt.` : 'Channel-Notification deaktiviert.')],
  });
}

export default adminFeedbackCommand;
