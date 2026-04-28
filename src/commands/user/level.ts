import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  MessageFlags,
} from 'discord.js';
import { Command } from '../../types';
import prisma from '../../database/prisma';
import { Colors, Brand, vEmbed, progressBar } from '../../utils/embedDesign';

/**
 * /level (Sektion 8):
 * Transparente XP- und Level-Anzeige.
 *
 * Wenn der Ziel-User noch keinen DB-Eintrag oder keine LevelData fuer diese
 * Guild hat, wird Level 0 / 0 XP angezeigt (statt Fehler). Konsistent zum
 * gefixten XP-System (jeder aktive Schreiber wird automatisch erfasst).
 */
const levelCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('level')
    .setDescription('Zeige Level und XP an')
    .setDMPermission(false)
    .addUserOption(opt =>
      opt.setName('user').setDescription('User dessen Level angezeigt werden soll').setRequired(false)
    ),

  execute: async (interaction: ChatInputCommandInteraction) => {
    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.reply({ content: '❌ /level nur in Servern verfügbar.', flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferReply();

    const targetUser = interaction.options.getUser('user') ?? interaction.user;

    const dbUser = await prisma.user.findUnique({
      where: { discordId: targetUser.id },
    });

    const ld = dbUser
      ? await prisma.levelData.findUnique({
          where: { userId_guildId: { userId: dbUser.id, guildId } },
        })
      : null;

    const level = ld?.level ?? 0;
    const currentXp = ld ? Number(ld.xp) : 0;
    const totalMessages = ld?.totalMessages ?? 0;
    const voiceMinutes = ld?.voiceMinutes ?? 0;

    const xpForCurrentLevel = xpForLevel(level);
    const xpForNextLevel = xpForLevel(level + 1);
    const xpProgress = currentXp - xpForCurrentLevel;
    const xpNeeded = xpForNextLevel - xpForCurrentLevel;
    const progressPercent = xpNeeded > 0 ? Math.min(100, Math.floor((xpProgress / xpNeeded) * 100)) : 0;
    const bar = progressBar(xpProgress, xpNeeded, 16);

    let rankStr = '—';
    if (ld) {
      const rank = await prisma.levelData.count({
        where: { guildId, xp: { gt: ld.xp } },
      }) + 1;
      rankStr = `#${rank}`;
    }

    const embed = vEmbed(Colors.Gold)
      .setTitle(`⭐  ${targetUser.username}`)
      .setThumbnail(targetUser.displayAvatarURL())
      .setDescription(
        `${Brand.divider}\n\n` +
        `🏆 **Level ${level}** ${Brand.dot} Rang **${rankStr}**\n\n` +
        `${bar}  **${progressPercent}%**\n` +
        `┃ ${xpProgress.toLocaleString('de-DE')} / ${xpNeeded.toLocaleString('de-DE')} XP\n\n` +
        Brand.divider
      )
      .addFields(
        { name: '✨ Gesamt-XP', value: `**${currentXp.toLocaleString('de-DE')}**`, inline: true },
        { name: '💬 Nachrichten', value: `**${totalMessages.toLocaleString('de-DE')}**`, inline: true },
        { name: '🎙️ Voice', value: `**${voiceMinutes.toLocaleString('de-DE')}** Min`, inline: true },
      );

    await interaction.editReply({ embeds: [embed] });
  },
};

function xpForLevel(level: number): number {
  return 100 * (level * level) + 50 * level;
}

export default levelCommand;
