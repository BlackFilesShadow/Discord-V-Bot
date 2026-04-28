import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  MessageFlags,
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

/**
 * /leaderboard (Sektion 8):
 * - Bestenliste (Top-Mitglieder, XP/Level/Nachrichten/Voice)
 * - Feed-Modus: persistent (BotConfig), wird beim Bot-Start wieder aktiviert
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
      )
    )
    .addIntegerOption(opt => opt
      .setName('seite').setDescription('Seite der Bestenliste').setRequired(false).setMinValue(1).setMaxValue(100)
    )
    .addStringOption(opt => opt
      .setName('modus').setDescription('Einmalig oder Intervall-Feed').setRequired(false)
      .addChoices(
        { name: 'Einmalig', value: 'once' },
        { name: 'Intervall (Feed)', value: 'feed' },
        { name: 'Feed stoppen', value: 'stop' },
      )
    )
    .addIntegerOption(opt => opt
      .setName('intervall').setDescription('Feed-Intervall in Minuten (nur bei Feed)')
      .setMinValue(1).setMaxValue(1440).setRequired(false)
    ),

  execute: async (interaction: ChatInputCommandInteraction) => {
    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.reply({ content: '❌ Leaderboard nur in Servern verfügbar.', flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferReply();

    const sortBy = (interaction.options.getString('sortierung') ?? 'xp') as FeedSortBy;
    const page = interaction.options.getInteger('seite') ?? 1;
    const modus = interaction.options.getString('modus') ?? 'once';
    const intervall = interaction.options.getInteger('intervall') ?? 60;

    // Feed stoppen?
    if (modus === 'stop') {
      await deleteFeed(interaction.channelId);
      await interaction.editReply({ content: '🛑 Leaderboard-Feed in diesem Channel gestoppt.' });
      return;
    }

    const embed = await buildLeaderboardEmbed(guildId, sortBy, page);

    // Eigener Rang als Footer-Append (nur einmalige Anzeige).
    const dbUser = await prisma.user.findUnique({ where: { discordId: interaction.user.id } });
    if (dbUser) {
      const ownLd = await prisma.levelData.findUnique({
        where: { userId_guildId: { userId: dbUser.id, guildId } },
      });
      if (ownLd) {
        const ownRank = await prisma.levelData.count({
          where: { guildId, xp: { gt: ownLd.xp } },
        }) + 1;
        const desc = embed.data.description ?? '';
        embed.setDescription(
          desc + `\n📍 Dein Rang: **#${ownRank}** (Level ${ownLd.level}, ${Number(ownLd.xp).toLocaleString('de-DE')} XP)\n${Brand.divider}`
        );
      }
    }

    if (modus === 'feed') {
      await startFeed(interaction.client, {
        guildId,
        channelId: interaction.channelId,
        sortBy,
        intervalMinutes: intervall,
      });
      await interaction.editReply({
        content: `✅ Leaderboard-Feed aktiv: alle ${intervall} min in diesem Channel. ` +
                 `Stoppen mit \`/leaderboard modus:Feed stoppen\`.`,
        embeds: [embed],
      });
      return;
    }

    // Einmalige Anzeige
    await interaction.editReply({ embeds: [embed] });
  },
};

export default leaderboardCommand;
