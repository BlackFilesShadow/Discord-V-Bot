import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js';
import { Command } from '../../types';
import prisma from '../../database/prisma';
import { Brand } from '../../utils/embedDesign';
import {
  buildLeaderboardEmbed,
  startFeed,
  deleteFeed,
  type FeedSortBy,
} from '../../modules/leaderboard/leaderboardFeed';
import { buildStatusEmbed } from '../../utils/statusEmbed';
import { logAudit } from '../../utils/logger';

/**
 * /leaderboard
 * - normale Bestenliste bleibt fuer alle Guild-Mitglieder verfuegbar;
 * - persistente Feed-Verwaltung (`feed`/`stop`) ist eine Channel-/Bot-
 *   Konfiguration und verlangt ManageGuild;
 * - alle Verwaltungsantworten sind Status-Embeds.
 */
const leaderboardCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Zeige die XP-Bestenliste')
    .setDMPermission(false)
    .addStringOption(opt => opt
      .setName('sortierung')
      .setDescription('Sortierung der Bestenliste')
      .setRequired(false)
      .addChoices(
        { name: 'XP', value: 'xp' },
        { name: 'Level', value: 'level' },
        { name: 'Nachrichten', value: 'messages' },
        { name: 'Voice-Minuten', value: 'voice' },
      ))
    .addIntegerOption(opt => opt
      .setName('seite').setDescription('Seite der Bestenliste').setRequired(false).setMinValue(1).setMaxValue(100))
    .addStringOption(opt => opt
      .setName('modus').setDescription('Einmalig oder Intervall-Feed').setRequired(false)
      .addChoices(
        { name: 'Einmalig', value: 'once' },
        { name: 'Intervall (Feed)', value: 'feed' },
        { name: 'Feed stoppen', value: 'stop' },
      ))
    .addIntegerOption(opt => opt
      .setName('intervall').setDescription('Feed-Intervall in Minuten (nur bei Feed)')
      .setMinValue(1).setMaxValue(1440).setRequired(false)),

  execute: async (interaction: ChatInputCommandInteraction) => {
    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.reply({
        embeds: [buildStatusEmbed({
          status: 'ERROR',
          title: 'Server erforderlich',
          description: 'Die Bestenliste ist nur auf Discord-Servern verfuegbar.',
          footerText: 'V-Bot • XP',
        })],
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }

    const sortBy = (interaction.options.getString('sortierung') ?? 'xp') as FeedSortBy;
    const page = interaction.options.getInteger('seite') ?? 1;
    const modus = interaction.options.getString('modus') ?? 'once';
    const intervall = interaction.options.getInteger('intervall') ?? 60;

    if ((modus === 'feed' || modus === 'stop') && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({
        embeds: [buildStatusEmbed({
          status: 'ERROR',
          title: 'Keine Berechtigung',
          description: 'Persistente Leaderboard-Feeds koennen nur Mitglieder mit **Server verwalten** starten oder stoppen. Die normale Bestenliste bleibt fuer dich verfuegbar.',
          footerText: 'V-Bot • XP',
        })],
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      logAudit('LEADERBOARD_FEED_PERMISSION_DENIED', 'SECURITY', {
        guildId,
        channelId: interaction.channelId,
        actor: interaction.user.id,
        mode: modus,
      });
      return;
    }

    await interaction.deferReply({ ephemeral: modus === 'stop' });

    if (modus === 'stop') {
      await deleteFeed(interaction.channelId);
      logAudit('LEADERBOARD_FEED_STOPPED', 'XP', {
        guildId,
        channelId: interaction.channelId,
        actor: interaction.user.id,
      });
      await interaction.editReply({
        embeds: [buildStatusEmbed({
          status: 'SUCCESS',
          title: 'Leaderboard-Feed gestoppt',
          description: 'Der persistente Leaderboard-Feed in diesem Channel wurde entfernt.',
          footerText: 'V-Bot • XP',
        })],
        allowedMentions: { parse: [] },
      });
      return;
    }

    const embed = await buildLeaderboardEmbed(guildId, sortBy, page);

    if (modus === 'once') {
      const dbUser = await prisma.user.findUnique({ where: { discordId: interaction.user.id } });
      if (dbUser) {
        const ownLd = await prisma.levelData.findUnique({
          where: { userId_guildId: { userId: dbUser.id, guildId } },
        });
        if (ownLd) {
          const ownRank = await prisma.levelData.count({ where: { guildId, xp: { gt: ownLd.xp } } }) + 1;
          const desc = embed.data.description ?? '';
          embed.setDescription(
            `${desc}\n📍 Dein Rang: **#${ownRank}** (Level ${ownLd.level}, ${Number(ownLd.xp).toLocaleString('de-DE')} XP)\n${Brand.divider}`,
          );
        }
      }
    }

    if (modus === 'feed') {
      await startFeed(interaction.client, {
        guildId,
        channelId: interaction.channelId,
        sortBy,
        intervalMinutes: intervall,
      });
      logAudit('LEADERBOARD_FEED_STARTED', 'XP', {
        guildId,
        channelId: interaction.channelId,
        actor: interaction.user.id,
        sortBy,
        intervalMinutes: intervall,
      });
      await interaction.editReply({
        embeds: [
          buildStatusEmbed({
            status: 'SUCCESS',
            title: 'Leaderboard-Feed aktiviert',
            description: `Dieser Channel erhaelt die Bestenliste jetzt alle **${intervall} Minuten**. Stoppen: \`/leaderboard modus:Feed stoppen\`.`,
            footerText: 'V-Bot • XP',
          }),
          embed,
        ],
        allowedMentions: { parse: [] },
      });
      return;
    }

    await interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
  },
};

export default leaderboardCommand;
