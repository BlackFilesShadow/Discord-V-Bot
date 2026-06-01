import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  MessageFlags,
} from 'discord.js';
import fs from 'fs/promises';
import { Command } from '../../types';
import prisma from '../../database/prisma';
import { logAudit, logger } from '../../utils/logger';
import { isInsideUploadRoot } from '../../utils/pathSafety';

/**
 * Löscht Files vom Filesystem. Best-effort – ein fehlender File ist kein Fehler.
 * Wird vor jedem Hard-Delete einer Package-Cascade aufgerufen, damit keine
 * Orphan-Files auf der Disk zurückbleiben.
 */
async function unlinkPackageFiles(packageIds: string[]): Promise<number> {
  if (packageIds.length === 0) return 0;
  const uploads = await prisma.upload.findMany({
    where: { packageId: { in: packageIds } },
    select: { id: true, filePath: true },
  });
  let removed = 0;
  for (const u of uploads) {
    // P0: Niemals Dateien ausserhalb des Upload-Root loeschen (manipulierter DB-Pfad).
    if (!isInsideUploadRoot(u.filePath)) {
      logger.error(`adminDelete: unlink ${u.filePath} ausserhalb Upload-Root blockiert.`);
      continue;
    }
    try {
      await fs.unlink(u.filePath);
      removed++;
    } catch (e) {
      logger.warn(`adminDelete: unlink ${u.filePath} fehlgeschlagen: ${(e as Error).message}`);
    }
  }
  return removed;
}

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
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

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
          // K2: zuerst Files vom Filesystem entfernen, dann DB-Cascade.
          const fsRemoved = await unlinkPackageFiles([pkg.id]);
          await prisma.package.delete({ where: { id: pkg.id } });
          logAudit('PACKAGE_HARD_DELETED', 'ADMIN', {
            packageId: pkg.id, packageName: pkg.name, adminId: interaction.user.id, fsRemoved,
          });
          await interaction.editReply({ content: `🗑️ Paket **${pkg.name}** endgültig gelöscht (${fsRemoved} Datei(en) entfernt).` });
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

        if (!upload || upload.isDeleted) {
          await interaction.editReply({ content: '❌ Datei nicht gefunden oder bereits gelöscht.' });
          return;
        }

        // K3: DB + Stats + FS in einer Transaktion (Stats konsistent halten).
        await prisma.$transaction([
          prisma.upload.update({
            where: { id: dateiId },
            data: { isDeleted: true, deletedAt: new Date() },
          }),
          prisma.package.update({
            where: { id: upload.packageId },
            data: {
              fileCount: { decrement: 1 },
              totalSize: { decrement: upload.fileSize },
            },
          }),
        ]);

        // FS-Cleanup best-effort, blockiert die Antwort nicht.
        if (isInsideUploadRoot(upload.filePath)) {
          try { await fs.unlink(upload.filePath); }
          catch (e) { logger.warn(`adminDelete datei: unlink ${upload.filePath} fehlgeschlagen: ${(e as Error).message}`); }
        } else {
          logger.error(`adminDelete datei: unlink ${upload.filePath} ausserhalb Upload-Root blockiert.`);
        }

        logAudit('FILE_DELETED', 'ADMIN', {
          uploadId: dateiId, fileName: upload.originalName, packageId: upload.packageId, adminId: interaction.user.id,
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
          // K2/K3: erst Files unlinken, dann Cascade.
          const userPackages = await prisma.package.findMany({
            where: { userId: dbUser.id },
            select: { id: true },
          });
          const fsRemoved = await unlinkPackageFiles(userPackages.map(p => p.id));
          const deleted = await prisma.package.deleteMany({ where: { userId: dbUser.id } });
          logAudit('BULK_HARD_DELETE', 'ADMIN', {
            userId: dbUser.id, count: deleted.count, fsRemoved, adminId: interaction.user.id,
          });
          await interaction.editReply({ content: `🗑️ ${deleted.count} Pakete von ${targetUser.username} endgültig gelöscht (${fsRemoved} Datei(en) entfernt).` });
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
