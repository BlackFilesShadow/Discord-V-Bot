import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
} from 'discord.js';
import { Command } from '../../types';
import prisma from '../../database/prisma';
import { generateOneTimePassword, hashPassword } from '../../utils/password';
import { logAudit, logger } from '../../utils/logger';

/**
 * /admin-reset-password [user] — Passwort/Token zurücksetzen, Ablaufzeit setzen.
 * Sektion 5: Sichere Passwort-/Token-Generierung und -Verwaltung.
 */
const adminResetPasswordCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('admin-reset-password')
    .setDescription('Passwort/Token eines Users zurücksetzen')
    .addUserOption(opt =>
      opt.setName('user').setDescription('Ziel-User').setRequired(true)
    )
    .addIntegerOption(opt =>
      opt
        .setName('ablauf-minuten')
        .setDescription('Ablaufzeit in Minuten (Standard: 30)')
        .setRequired(false)
        .setMinValue(5)
        .setMaxValue(1440)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator) as SlashCommandBuilder,
  adminOnly: true,

  execute: async (interaction: ChatInputCommandInteraction) => {
    await interaction.deferReply({ ephemeral: true });

    const targetUser = interaction.options.getUser('user', true);
    const expiryMinutes = interaction.options.getInteger('ablauf-minuten') || 30;

    const dbUser = await prisma.user.findUnique({
      where: { discordId: targetUser.id },
    });

    if (!dbUser) {
      await interaction.editReply({ content: '❌ User nicht in der Datenbank.' });
      return;
    }

    // Alte OTPs invalidieren
    await prisma.oneTimePassword.updateMany({
      where: { userId: dbUser.id, isUsed: false, isRevoked: false },
      data: { isRevoked: true },
    });

    // Neues OTP generieren
    const otp = generateOneTimePassword(48);
    const otpHash = await hashPassword(otp);
    const expiresAt = new Date(Date.now() + expiryMinutes * 60 * 1000);

    await prisma.oneTimePassword.create({
      data: {
        userId: dbUser.id,
        passwordHash: otpHash,
        expiresAt,
      },
    });

    // User per DM benachrichtigen
    try {
      const dm = await targetUser.createDM();
      await dm.send(
        `🔐 **Passwort-Reset**\n\n` +
        `Dein neues Einmal-Passwort: \`${otp}\`\n` +
        `Gültig für: **${expiryMinutes} Minuten**\n\n` +
        `Verwende \`/register verify\` zur Verifizierung.`
      );
    } catch {
      logger.warn(`Konnte DM an ${targetUser.id} nicht senden.`);
    }

    logAudit('PASSWORD_RESET', 'ADMIN', {
      targetUserId: dbUser.id,
      adminId: interaction.user.id,
      expiryMinutes,
    });

    await interaction.editReply({
      content: `🔐 Neues OTP für ${targetUser.username} generiert (${expiryMinutes} Min. gültig). DM wurde gesendet.`,
    });
  },
};

export default adminResetPasswordCommand;
