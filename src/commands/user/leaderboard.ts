import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { Command } from '../../types';
import prisma from '../../database/prisma';

/**
 * /leaderboard Command (Sektion 8):
 * - Bestenliste (Top-Mitglieder, Punkte, Levels)
 * - XP-Ränge und Levels
 */
const leaderboardCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Zeige die XP-Bestenliste')
    .addStringOption(opt =>
      opt
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
    .addIntegerOption(opt =>
      opt
        .setName('seite')
        .setDescription('Seite der Bestenliste')
        .setRequired(false)
        .setMinValue(1)
    ),

  execute: async (interaction: ChatInputCommandInteraction) => {
    await interaction.deferReply();

    const sortBy = (interaction.options.getString('sortierung') || 'xp') as string;
    const page = (interaction.options.getInteger('seite') || 1);
    const perPage = 10;
    const skip = (page - 1) * perPage;

    let orderBy: Record<string, string>;
    let sortLabel: string;

    switch (sortBy) {
      case 'level':
        orderBy = { level: 'desc' };
        sortLabel = 'Level';
        break;
      case 'messages':
        orderBy = { totalMessages: 'desc' };
        sortLabel = 'Nachrichten';
        break;
      case 'voice':
        orderBy = { voiceMinutes: 'desc' };
        sortLabel = 'Voice-Minuten';
        break;
      default:
        orderBy = { xp: 'desc' };
        sortLabel = 'XP';
        break;
    }

    const [entries, total] = await Promise.all([
      prisma.levelData.findMany({
        orderBy,
        skip,
        take: perPage,
        include: { user: true },
      }),
      prisma.levelData.count(),
    ]);

    const totalPages = Math.ceil(total / perPage);

    if (entries.length === 0) {
      await interaction.editReply({ content: '❌ Keine Level-Daten vorhanden.' });
      return;
    }

    const medals = ['🥇', '🥈', '🥉'];

    const lines = entries.map((entry: any, i: number) => {
      const position = skip + i + 1;
      const medal = position <= 3 ? medals[position - 1] : `**${position}.**`;
      const xp = Number(entry.xp).toLocaleString('de-DE');

      let valueStr: string;
      switch (sortBy) {
        case 'level':
          valueStr = `Level ${entry.level}`;
          break;
        case 'messages':
          valueStr = `${entry.totalMessages.toLocaleString('de-DE')} Nachrichten`;
          break;
        case 'voice':
          valueStr = `${entry.voiceMinutes.toLocaleString('de-DE')} Min`;
          break;
        default:
          valueStr = `${xp} XP (Lvl ${entry.level})`;
          break;
      }

      return `${medal} <@${entry.user.discordId}> — ${valueStr}`;
    });

    // Eigene Position
    const dbUser = await prisma.user.findUnique({
      where: { discordId: interaction.user.id },
      include: { levelData: true },
    });

    let ownRankStr = '';
    if (dbUser?.levelData) {
      const ownRank = await prisma.levelData.count({
        where: { xp: { gt: dbUser.levelData.xp } },
      }) + 1;
      ownRankStr = `\n\n📍 Dein Rang: **#${ownRank}** (Level ${dbUser.levelData.level}, ${Number(dbUser.levelData.xp).toLocaleString('de-DE')} XP)`;
    }

    const embed = new EmbedBuilder()
      .setTitle(`🏆 Bestenliste — ${sortLabel}`)
      .setColor(0xffd700)
      .setDescription(lines.join('\n') + ownRankStr)
      .setFooter({ text: `Seite ${page}/${totalPages} • ${total} Mitglieder gesamt` })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  },
};

export default leaderboardCommand;
