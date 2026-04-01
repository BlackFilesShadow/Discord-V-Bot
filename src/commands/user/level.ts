import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { Command } from '../../types';
import prisma from '../../database/prisma';

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

    const targetUser = interaction.options.getUser('user') || interaction.user;

    const dbUser = await prisma.user.findUnique({
      where: { discordId: targetUser.id },
      include: { levelData: true },
    });

    if (!dbUser || !dbUser.levelData) {
      await interaction.editReply({ content: `❌ Keine Level-Daten für ${targetUser.username} gefunden.` });
      return;
    }

    const ld = dbUser.levelData;
    const currentXp = Number(ld.xp);
    const xpForCurrentLevel = xpForLevel(ld.level);
    const xpForNextLevel = xpForLevel(ld.level + 1);
    const xpProgress = currentXp - xpForCurrentLevel;
    const xpNeeded = xpForNextLevel - xpForCurrentLevel;
    const progressPercent = Math.min(100, Math.floor((xpProgress / xpNeeded) * 100));

    // Fortschrittsbalken
    const barLength = 20;
    const filled = Math.floor((progressPercent / 100) * barLength);
    const progressBar = '█'.repeat(filled) + '░'.repeat(barLength - filled);

    // Rang berechnen
    const rank = await prisma.levelData.count({
      where: { xp: { gt: ld.xp } },
    }) + 1;

    const embed = new EmbedBuilder()
      .setTitle(`⭐ Level von ${targetUser.username}`)
      .setColor(0xffd700)
      .setThumbnail(targetUser.displayAvatarURL())
      .addFields(
        { name: '🏆 Level', value: ld.level.toString(), inline: true },
        { name: '✨ XP', value: `${currentXp.toLocaleString('de-DE')}`, inline: true },
        { name: '🏅 Rang', value: `#${rank}`, inline: true },
        { name: '📊 Fortschritt', value: `${progressBar} ${progressPercent}%\n${xpProgress.toLocaleString('de-DE')} / ${xpNeeded.toLocaleString('de-DE')} XP`, inline: false },
        { name: '💬 Nachrichten', value: ld.totalMessages.toLocaleString('de-DE'), inline: true },
        { name: '🎙️ Voice (Min)', value: ld.voiceMinutes.toLocaleString('de-DE'), inline: true },
      )
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  },
};

function xpForLevel(level: number): number {
  return 100 * (level * level) + 50 * level;
}

export default levelCommand;
