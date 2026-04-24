import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { Command } from '../../types';
import prisma from '../../database/prisma';
import { Colors, Brand, vEmbed, progressBar } from '../../utils/embedDesign';

/**
 * /level Command (Sektion 8):
 * - Transparente XP- und Level-Anzeige im Profil oder per Command
 */
const levelCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('level')
    .setDescription('Zeige Level und XP an')
    .addUserOption(opt =>
      opt.setName('user').setDescription('User dessen Level angezeigt werden soll').setRequired(false)
    ),

  execute: async (interaction: ChatInputCommandInteraction) => {
    await interaction.deferReply();

    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.editReply({ content: '❌ /level nur in Servern verfügbar.' });
      return;
    }

    const targetUser = interaction.options.getUser('user') || interaction.user;

    const dbUser = await prisma.user.findUnique({
      where: { discordId: targetUser.id },
    });

    if (!dbUser) {
      await interaction.editReply({ content: `❌ Keine Daten für ${targetUser.username} gefunden.` });
      return;
    }

    const ld = await prisma.levelData.findUnique({
      where: { userId_guildId: { userId: dbUser.id, guildId } },
    });

    if (!ld) {
      await interaction.editReply({ content: `❌ Keine Level-Daten für ${targetUser.username} auf diesem Server.` });
      return;
    }

    const currentXp = Number(ld.xp);
    const xpForCurrentLevel = xpForLevel(ld.level);
    const xpForNextLevel = xpForLevel(ld.level + 1);
    const xpProgress = currentXp - xpForCurrentLevel;
    const xpNeeded = xpForNextLevel - xpForCurrentLevel;
    const progressPercent = Math.min(100, Math.floor((xpProgress / xpNeeded) * 100));

    // Fortschrittsbalken
    const barLength = 16;
    const bar = progressBar(xpProgress, xpNeeded, barLength);

    // Rang berechnen (nur in dieser Guild)
    const rank = await prisma.levelData.count({
      where: { guildId, xp: { gt: ld.xp } },
    }) + 1;

    const embed = vEmbed(Colors.Gold)
      .setTitle(`⭐  ${targetUser.username}`)
      .setThumbnail(targetUser.displayAvatarURL())
      .setDescription(
        `${Brand.divider}\n\n` +
        `🏆 **Level ${ld.level}** ${Brand.dot} Rang **#${rank}**\n\n` +
        `${bar}  **${progressPercent}%**\n` +
        `┃ ${xpProgress.toLocaleString('de-DE')} / ${xpNeeded.toLocaleString('de-DE')} XP\n\n` +
        Brand.divider
      )
      .addFields(
        { name: '✨ Gesamt-XP', value: `**${currentXp.toLocaleString('de-DE')}**`, inline: true },
        { name: '💬 Nachrichten', value: `**${ld.totalMessages.toLocaleString('de-DE')}**`, inline: true },
        { name: '🎙️ Voice', value: `**${ld.voiceMinutes.toLocaleString('de-DE')}** Min`, inline: true },
      );

    await interaction.editReply({ embeds: [embed] });
  },
};

function xpForLevel(level: number): number {
  return 100 * (level * level) + 50 * level;
}

export default levelCommand;
