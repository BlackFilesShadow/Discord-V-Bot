import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
} from 'discord.js';
import { Command } from '../../types';
import prisma from '../../database/prisma';
import { logAudit } from '../../utils/logger';

/**
 * /admin-delete [user|paket|datei] — Löschen (Soft/Hard), Restore, Bulk-Operationen.
 * Developer-Bereich: Bulk-Operationen.
 */
const adminDeleteCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('admin-delete')
    .setDescription('Pakete oder Dateien löschen/wiederherstellen')
    .addSubcommand(sub =>
      sub
        .setName('paket')
        .setDescription('Paket löschen')
        .addStringOption(opt =>
          opt.setName('paket-id').setDescription('Paket-ID oder -Name').setRequired(true)
        )
        .addBooleanOption(opt =>
          opt.setName('hard').setDescription('Endgültig löschen (nicht wiederherstellbar)').setRequired(false)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('datei')
        .setDescription('Einzelne Datei löschen')
        .addStringOption(opt =>
          opt.setName('datei-id').setDescription('Datei-Upload-ID').setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('restore')
        .setDescription('Gelöschtes Paket wiederherstellen')
        .addStringOption(opt =>
          opt.setName('paket-id').setDescription('Paket-ID').setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('bulk')
        .setDescription('Alle Pakete eines Users löschen')
        .addUserOption(opt =>
          opt.setName('user').setDescription('Ziel-User').setRequired(true)
        )
        .addBooleanOption(opt =>
          opt.setName('hard').setDescription('Endgültig löschen').setRequired(false)
        )
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator) as SlashCommandBuilder,
  adminOnly: true,

  execute: async (interaction: ChatInputCommandInteraction) => {
    await interaction.deferReply({ ephemeral: true });

    const sub = interaction.options.getSubcommand();

    switch (sub) {
      case 'paket': {
        const paketId = interaction.options.getString('paket-id', true);
        const hard = interaction.options.getBoolean('hard') || false;

        const pkg = await prisma.package.findFirst({
          where: { OR: [{ id: paketId }, { name: paketId }] },
        });

        if (!pkg) {
          await interaction.editReply({ content: '❌ Paket nicht gefunden.' });
          return;
        }

        if (hard) {
          await prisma.package.delete({ where: { id: pkg.id } });
          logAudit('PACKAGE_HARD_DELETED', 'ADMIN', {
            packageId: pkg.id, packageName: pkg.name, adminId: interaction.user.id,
          });
          await interaction.editReply({ content: `🗑️ Paket **${pkg.name}** endgültig gelöscht.` });
        } else {
          await prisma.package.update({
            where: { id: pkg.id },
            data: { isDeleted: true, deletedAt: new Date(), deletedBy: interaction.user.id, status: 'DELETED' },
          });
          logAudit('PACKAGE_SOFT_DELETED', 'ADMIN', {
            packageId: pkg.id, packageName: pkg.name, adminId: interaction.user.id,
          });
          await interaction.editReply({ content: `🗑️ Paket **${pkg.name}** (Soft-Delete). Wiederherstellung möglich.` });
        }
        break;
      }

      case 'datei': {
        const dateiId = interaction.options.getString('datei-id', true);
        const upload = await prisma.upload.findUnique({ where: { id: dateiId } });

        if (!upload) {
          await interaction.editReply({ content: '❌ Datei nicht gefunden.' });
          return;
        }

        await prisma.upload.update({
          where: { id: dateiId },
          data: { isDeleted: true, deletedAt: new Date() },
        });
        logAudit('FILE_DELETED', 'ADMIN', {
          uploadId: dateiId, fileName: upload.originalName, adminId: interaction.user.id,
        });
        await interaction.editReply({ content: `🗑️ Datei **${upload.originalName}** gelöscht.` });
        break;
      }

      case 'restore': {
        const restoreId = interaction.options.getString('paket-id', true);
        const pkg = await prisma.package.findUnique({ where: { id: restoreId } });

        if (!pkg || !pkg.isDeleted) {
          await interaction.editReply({ content: '❌ Kein gelöschtes Paket mit dieser ID gefunden.' });
          return;
        }

        await prisma.package.update({
          where: { id: restoreId },
          data: { isDeleted: false, deletedAt: null, deletedBy: null, status: 'ACTIVE' },
        });
        logAudit('PACKAGE_RESTORED', 'ADMIN', {
          packageId: restoreId, packageName: pkg.name, adminId: interaction.user.id,
        });
        await interaction.editReply({ content: `♻️ Paket **${pkg.name}** wiederhergestellt.` });
        break;
      }

      case 'bulk': {
        const targetUser = interaction.options.getUser('user', true);
        const hard = interaction.options.getBoolean('hard') || false;

        const dbUser = await prisma.user.findUnique({ where: { discordId: targetUser.id } });
        if (!dbUser) {
          await interaction.editReply({ content: '❌ User nicht in der Datenbank.' });
          return;
        }

        if (hard) {
          const deleted = await prisma.package.deleteMany({ where: { userId: dbUser.id } });
          logAudit('BULK_HARD_DELETE', 'ADMIN', {
            userId: dbUser.id, count: deleted.count, adminId: interaction.user.id,
          });
          await interaction.editReply({ content: `🗑️ ${deleted.count} Pakete von ${targetUser.username} endgültig gelöscht.` });
        } else {
          const updated = await prisma.package.updateMany({
            where: { userId: dbUser.id, isDeleted: false },
            data: { isDeleted: true, deletedAt: new Date(), deletedBy: interaction.user.id, status: 'DELETED' },
          });
          logAudit('BULK_SOFT_DELETE', 'ADMIN', {
            userId: dbUser.id, count: updated.count, adminId: interaction.user.id,
          });
          await interaction.editReply({ content: `🗑️ ${updated.count} Pakete von ${targetUser.username} (Soft-Delete).` });
        }
        break;
      }
    }
  },
};

export default adminDeleteCommand;
