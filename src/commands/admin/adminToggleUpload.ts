import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
} from 'discord.js';
import { Command } from '../../types';
import prisma from '../../database/prisma';
import { logAudit } from '../../utils/logger';

/**
 * /admin-toggle-upload [user] — Uploadrechte temporär entziehen/geben, History.
 * Sektion 1: Uploadrechte nur für eigenen GUID-Bereich.
 */
const adminToggleUploadCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('admin-toggle-upload')
    .setDescription('Uploadrechte eines Users temporär entziehen oder wiederherstellen')
    .addUserOption(opt =>
      opt.setName('user').setDescription('Ziel-User').setRequired(true)
    )
    .addBooleanOption(opt =>
      opt.setName('aktivieren').setDescription('Uploads erlauben? (false = sperren)').setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName('grund').setDescription('Begründung').setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator) as SlashCommandBuilder,
  adminOnly: true,

  execute: async (interaction: ChatInputCommandInteraction) => {
    await interaction.deferReply({ ephemeral: true });

    const targetUser = interaction.options.getUser('user', true);
    const enable = interaction.options.getBoolean('aktivieren', true);
    const reason = interaction.options.getString('grund') || 'Keine Angabe';

    const dbUser = await prisma.user.findUnique({ where: { discordId: targetUser.id } });
    if (!dbUser) {
      await interaction.editReply({ content: '❌ User nicht in der Datenbank.' });
      return;
    }

    const newStatus = enable ? 'ACTIVE' : 'SUSPENDED';
    await prisma.user.update({
      where: { id: dbUser.id },
      data: { status: newStatus as 'ACTIVE' | 'SUSPENDED' },
    });

    logAudit('UPLOAD_TOGGLE', 'ADMIN', {
      targetUserId: dbUser.id,
      targetDiscordId: targetUser.id,
      adminId: interaction.user.id,
      enabled: enable,
      reason,
    });

    const action = enable ? '✅ Uploadrechte **aktiviert**' : '🚫 Uploadrechte **entzogen**';
    await interaction.editReply({
      content: `${action} für ${targetUser.username}.\nGrund: ${reason}`,
    });
  },
};

export default adminToggleUploadCommand;
