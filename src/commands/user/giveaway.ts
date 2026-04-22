import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import { Command } from '../../types';
import {
  createGiveaway,
  createGiveawayEmbed,
  enterGiveaway,
  drawWinners,
} from '../../modules/giveaway/giveawayManager';
import { grantEventXp } from '../../modules/xp/xpManager';
import prisma from '../../database/prisma';

import { Colors, Brand, vEmbed } from '../../utils/embedDesign';
import { createBotEmbed } from '../../utils/embedUtil';

/**
 * /giveaway Command (Sektion 6): Giveaway-System.
 */
const giveawayCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('giveaway')
    .setDescription('Giveaway-System')
    .addSubcommand(sub =>
      sub
        .setName('start')
        .setDescription('Neues Giveaway starten')
        .addStringOption(opt =>
          opt.setName('preis').setDescription('Name des Preises/Items').setRequired(true)
        )
        .addStringOption(opt =>
          opt.setName('dauer').setDescription('Dauer (z.B. 1h, 30m, 2d, 1w)').setRequired(true)
        )
        .addStringOption(opt =>
          opt.setName('beschreibung').setDescription('Beschreibung des Giveaways').setRequired(false)
        )
        .addIntegerOption(opt =>
          opt.setName('gewinner').setDescription('Anzahl Gewinner (Standard: 1)').setRequired(false)
        )
        .addRoleOption(opt =>
          opt.setName('mindestrolle').setDescription('Mindestrolle für Teilnahme').setRequired(false)
        )
        .addStringOption(opt =>
          opt.setName('emoji').setDescription('Custom Emoji für Teilnahme (Standard: 🎉)').setRequired(false)
        )
        .addRoleOption(opt =>
          opt.setName('benachrichtigungs-rolle').setDescription('Rolle die bei Beendigung gepingt wird (optional)').setRequired(false)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('enter')
        .setDescription('An einem Giveaway teilnehmen')
        .addStringOption(opt =>
          opt.setName('id').setDescription('Giveaway-ID').setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('info')
        .setDescription('Info zu einem Giveaway')
        .addStringOption(opt =>
          opt.setName('id').setDescription('Giveaway-ID').setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('end')
        .setDescription('Giveaway vorzeitig beenden')
        .addStringOption(opt =>
          opt.setName('id').setDescription('Giveaway-ID').setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('list')
        .setDescription('Aktive Giveaways anzeigen')
    ),

  execute: async (interaction: ChatInputCommandInteraction) => {
    const sub = interaction.options.getSubcommand();

    switch (sub) {
      case 'start': await handleStart(interaction); break;
      case 'enter': await handleEnter(interaction); break;
      case 'info': await handleInfo(interaction); break;
      case 'end': await handleEnd(interaction); break;
      case 'list': await handleList(interaction); break;
    }
  },
};

async function handleStart(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();

  const prize = interaction.options.getString('preis', true);
  const durationStr = interaction.options.getString('dauer', true);
  const description = interaction.options.getString('beschreibung') || undefined;
  const winnerCount = interaction.options.getInteger('gewinner') || 1;
  const minRole = interaction.options.getRole('mindestrolle');
  const customEmoji = interaction.options.getString('emoji') || '🎉';
  const notifyRole = interaction.options.getRole('benachrichtigungs-rolle');

  // Dauer parsen
  const durationSeconds = parseDuration(durationStr);
  if (!durationSeconds || durationSeconds <= 0) {
    await interaction.editReply({ content: '❌ Ungültige Dauer. Verwende z.B.: 1h, 30m, 2d, 1w' });
    return;
  }

  const result = await createGiveaway({
    creatorDiscordId: interaction.user.id,
    channelId: interaction.channelId,
    prize,
    description,
    durationSeconds,
    winnerCount,
    minRole: minRole?.id,
    customEmoji,
    notifyRoleId: notifyRole?.id,
  });

  if (!result.success) {
    await interaction.editReply({ content: `❌ ${result.message}` });
    return;
  }

  const giveaway = await prisma.giveaway.findUnique({
    where: { id: result.giveawayId },
  });

  if (!giveaway) {
    await interaction.editReply({ content: '❌ Giveaway konnte nicht erstellt werden.' });
    return;
  }


  // Neues Embed-Design mit createBotEmbed
  const embed = createBotEmbed({
    title: '🎉 GIVEAWAY',
    description: [
      giveaway.description ? `> ${giveaway.description}` : undefined,
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      `🏆 **Preis:** ${giveaway.prize}`,
      `⏰ **Endet:** <t:${Math.floor(giveaway.endsAt.getTime() / 1000)}:R>`,
      `👥 **Teilnehmer:** 0`,
      `🎁 **Von:** ${interaction.user.username}`,
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      `*Klicke auf den Button um teilzunehmen!*`,
    ].filter(Boolean).join('\n'),
    fields: [
      { name: '🆔 ID', value: giveaway.id, inline: false },
    ],
    color: Colors.Giveaway,
    footer: `${Brand.footerText} • Giveaway`,
    timestamp: true,
  });

  // Teilnahme-Button
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`giveaway_enter_${giveaway.id}`)
      .setLabel('Teilnehmen')
      .setEmoji(customEmoji)
      .setStyle(ButtonStyle.Success),
  );

  const msg = await interaction.editReply({ embeds: [embed], components: [row] });

  // Keine Bot-Reaktion: Bot soll nicht als Teilnehmer zählen.
  // Nutzer klicken den Button zum Teilnehmen.

  // Message-ID speichern
  await prisma.giveaway.update({
    where: { id: giveaway.id },
    data: { messageId: msg.id },
  });
}

async function handleEnter(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const giveawayId = interaction.options.getString('id', true);
  const result = await enterGiveaway(giveawayId, interaction.user.id);

  // Event-XP für Giveaway-Teilnahme (Sektion 8: Event-XP)
  if (result.success) {
    try {
      const dbUser = await prisma.user.findUnique({ where: { discordId: interaction.user.id } });
      if (dbUser) {
        await grantEventXp(dbUser.id, 10, 'GIVEAWAY_ENTRY', giveawayId);
      }
    } catch { /* XP grant not critical */ }
  }

  await interaction.editReply({
    content: result.success ? `✅ ${result.message}` : `❌ ${result.message}`,
  });
}

async function handleInfo(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();

  const giveawayId = interaction.options.getString('id', true);
  const giveaway = await prisma.giveaway.findUnique({
    where: { id: giveawayId },
    include: {
      creator: { select: { username: true } },
      _count: { select: { entries: true } },
    },
  });

  if (!giveaway) {
    await interaction.editReply({ content: '❌ Giveaway nicht gefunden.' });
    return;
  }

  // Neues Embed-Design mit createBotEmbed
  const embed = createBotEmbed({
    title: '🎉 GIVEAWAY',
    description: [
      giveaway.description ? `> ${giveaway.description}` : undefined,
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      `🏆 **Preis:** ${giveaway.prize}`,
      `⏰ **Endet:** <t:${Math.floor(giveaway.endsAt.getTime() / 1000)}:R>`,
      `👥 **Teilnehmer:** ${giveaway._count.entries}`,
      `🎁 **Von:** ${giveaway.creator.username}`,
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      `*Reagiere mit ${giveaway.customEmoji || '🎉'} um teilzunehmen!*`,
    ].filter(Boolean).join('\n'),
    fields: [
      { name: '🆔 ID', value: giveaway.id, inline: false },
    ],
    color: Colors.Giveaway,
    footer: `${Brand.footerText} • Giveaway`,
    timestamp: true,
  });
  await interaction.editReply({ embeds: [embed] });
}

async function handleEnd(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();

  const giveawayId = interaction.options.getString('id', true);

  const giveaway = await prisma.giveaway.findUnique({
    where: { id: giveawayId },
    include: { creator: true },
  });

  if (!giveaway) {
    await interaction.editReply({ content: '❌ Giveaway nicht gefunden.' });
    return;
  }

  // Nur Ersteller oder Admin darf beenden
  const dbUser = await prisma.user.findUnique({
    where: { discordId: interaction.user.id },
  });

  if (giveaway.creator.discordId !== interaction.user.id &&
    dbUser?.role !== 'ADMIN' && dbUser?.role !== 'SUPER_ADMIN' && dbUser?.role !== 'DEVELOPER') {
    await interaction.editReply({ content: '❌ Nur der Ersteller oder ein Admin kann das Giveaway beenden.' });
    return;
  }

  const result = await drawWinners(giveawayId);

  if (result.success && result.winners.length > 0) {
    const winnerMentions = result.winners.map(w => `<@${w.discordId}>`).join(', ');
    await interaction.editReply({
      content: `🎉 Giveaway beendet! Gewinner: ${winnerMentions} – **${giveaway.prize}**`,
    });

    // Rollen-Ping als separate Nachricht im Channel
    if (giveaway.notifyRoleId && interaction.channel && 'send' in interaction.channel) {
      await interaction.channel.send({
        content: `<@&${giveaway.notifyRoleId}> 🎉 Giveaway **${giveaway.prize}** beendet! Gewinner: ${winnerMentions}`,
      });
    }
  } else {
    await interaction.editReply({ content: `Giveaway beendet. ${result.message}` });

    if (giveaway.notifyRoleId && interaction.channel && 'send' in interaction.channel) {
      await interaction.channel.send({
        content: `<@&${giveaway.notifyRoleId}> 🎉 Giveaway **${giveaway.prize}** wurde beendet. ${result.message}`,
      });
    }
  }
}

async function handleList(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();

  const activeGiveaways = await prisma.giveaway.findMany({
    where: { status: 'ACTIVE', endsAt: { gt: new Date() } },
    include: {
      creator: { select: { username: true } },
      _count: { select: { entries: true } },
    },
    orderBy: { endsAt: 'asc' },
    take: 10,
  });

  if (activeGiveaways.length === 0) {
    await interaction.editReply({ content: '🎉 Keine aktiven Giveaways.' });
    return;
  }

  const fields = activeGiveaways.map(g => ({
    name: `🏆 ${g.prize}`,
    value: [
      `⏰ Endet: <t:${Math.floor(g.endsAt.getTime() / 1000)}:R>`,
      `👥 Teilnehmer: **${g._count.entries}**`,
      `🎁 Von: ${g.creator.username}`,
      `\`${g.id}\``,
    ].join('\n'),
    inline: true,
  }));

  const embed = createBotEmbed({
    title: '🎉 Aktive Giveaways',
    color: Colors.Giveaway,
    fields,
    footer: `${Brand.footerText} • Giveaway`,
    timestamp: true,
  });

  await interaction.editReply({ embeds: [embed] });
}

/**
 * Dauer-String parsen (z.B. "1h", "30m", "2d", "1w").
 */
function parseDuration(str: string): number | null {
  const match = str.match(/^(\d+)(s|m|h|d|w)$/i);
  if (!match) return null;

  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();

  switch (unit) {
    case 's': return value;
    case 'm': return value * 60;
    case 'h': return value * 3600;
    case 'd': return value * 86400;
    case 'w': return value * 604800;
    default: return null;
  }
}

export default giveawayCommand;
