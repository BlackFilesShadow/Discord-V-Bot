import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { Command } from '../../types';
import prisma from '../../database/prisma';
import { Colors, Brand, vEmbed } from '../../utils/embedDesign';
import { safeSend } from '../../utils/safeSend';
import { logger } from '../../utils/logger';

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
    )
    .addStringOption(opt =>
      opt
        .setName('modus')
        .setDescription('Feed-Modus: einmalig oder Intervall')
        .setRequired(false)
        .addChoices(
          { name: 'Einmalig', value: 'once' },
          { name: 'Intervall (Feed)', value: 'feed' },
        )
    )
    .addIntegerOption(opt =>
      opt
        .setName('intervall')
        .setDescription('Feed-Intervall in Minuten (nur bei Feed)')
        .setMinValue(1)
        .setMaxValue(1440)
        .setRequired(false)
    ),

  execute: async (interaction: ChatInputCommandInteraction) => {
    await interaction.deferReply();

    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.editReply({ content: '❌ Leaderboard nur in Servern verfügbar.' });
      return;
    }

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
        where: { guildId },
        orderBy,
        skip,
        take: perPage,
        include: { user: true },
      }),
      prisma.levelData.count({ where: { guildId } }),
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

    // Eigene Position in DIESER Guild
    const dbUser = await prisma.user.findUnique({
      where: { discordId: interaction.user.id },
    });

    let ownRankStr = '';
    if (dbUser) {
      const ownLd = await prisma.levelData.findUnique({
        where: { userId_guildId: { userId: dbUser.id, guildId } },
      });
      if (ownLd) {
        const ownRank = await prisma.levelData.count({
          where: { guildId, xp: { gt: ownLd.xp } },
        }) + 1;
        ownRankStr = `\n\n📍 Dein Rang: **#${ownRank}** (Level ${ownLd.level}, ${Number(ownLd.xp).toLocaleString('de-DE')} XP)`;
      }
    }

    const embed = vEmbed(Colors.Gold)
      .setTitle(`🏆  Bestenliste — ${sortLabel}`)
      .setDescription(
        `${Brand.divider}\n\n` +
        lines.join('\n') +
        ownRankStr +
        `\n\n${Brand.divider}`
      )
      .setFooter({ text: `Seite ${page}/${totalPages} ${Brand.dot} ${total} Mitglieder ${Brand.dot} ${Brand.footerText}` });

    const modus = interaction.options.getString('modus') || 'once';
    const intervall = interaction.options.getInteger('intervall') || 60;

    if (modus === 'feed') {
      // Feed-Modus: Leaderboard wird im Intervall gepostet
      await interaction.editReply({ content: `⏳ Leaderboard-Feed wird alle ${intervall} Minuten gepostet. Zum Stoppen: /leaderboard mit Modus 'once' ausführen.`, embeds: [] });

      // Feed-Logik: Intervall speichern (in-memory, pro Channel)
      // Hinweis: Für produktiven Einsatz sollte ein persistenter Speicher genutzt werden!
      const gAny = globalThis as { leaderboardFeeds?: Record<string, NodeJS.Timeout> };
      if (!gAny.leaderboardFeeds) gAny.leaderboardFeeds = {};
      const channelId = interaction.channelId;
      if (gAny.leaderboardFeeds[channelId]) {
        clearInterval(gAny.leaderboardFeeds[channelId]);
      }
      gAny.leaderboardFeeds[channelId] = setInterval(() => {
        // Channel kann inzwischen geloescht oder Bot rausgekickt sein.
        const ch = interaction.channel;
        if (!ch || !('send' in ch)) return;
        void safeSend(ch, { embeds: [embed] }).catch((e: unknown) => {
          logger.warn(`leaderboard-feed Send fehlgeschlagen: ${String(e)}`);
        });
      }, intervall * 60 * 1000);
      // Direkt initial posten
      if (interaction.channel && 'send' in interaction.channel) {
        await safeSend(interaction.channel, { embeds: [embed] });
      }
      return;
    } else {
      // Einmalige Anzeige
      await interaction.editReply({ embeds: [embed] });
      // Feed ggf. stoppen
      const gAny = globalThis as { leaderboardFeeds?: Record<string, NodeJS.Timeout> };
      if (gAny.leaderboardFeeds && gAny.leaderboardFeeds[interaction.channelId]) {
        clearInterval(gAny.leaderboardFeeds[interaction.channelId]);
        delete gAny.leaderboardFeeds[interaction.channelId];
      }
    }
  },
};

export default leaderboardCommand;
