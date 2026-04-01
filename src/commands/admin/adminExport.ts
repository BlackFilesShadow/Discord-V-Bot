import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  AttachmentBuilder,
} from 'discord.js';
import { Command } from '../../types';
import prisma from '../../database/prisma';
import { logAudit } from '../../utils/logger';
import archiver from 'archiver';
import fs from 'fs';
import path from 'path';
import { config } from '../../config';
import { Writable } from 'stream';

/**
 * /admin-export [bereich|paket] — Export für Backup, Analyse, Compliance.
 * Developer-Bereich: Exportfunktionen.
 */
const adminExportCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('admin-export')
    .setDescription('Daten exportieren (Backup, Analyse, Compliance)')
    .addSubcommand(sub =>
      sub
        .setName('pakete')
        .setDescription('Alle Pakete eines Users exportieren')
        .addUserOption(opt =>
          opt.setName('user').setDescription('Ziel-User').setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('logs')
        .setDescription('Audit-Logs exportieren')
        .addStringOption(opt =>
          opt
            .setName('kategorie')
            .setDescription('Log-Kategorie')
            .setRequired(false)
            .addChoices(
              { name: 'Alle', value: 'ALL' },
              { name: 'Security', value: 'SECURITY' },
              { name: 'Moderation', value: 'MODERATION' },
              { name: 'GDPR', value: 'GDPR' },
            )
        )
        .addIntegerOption(opt =>
          opt.setName('tage').setDescription('Letzten X Tage exportieren').setRequired(false).setMinValue(1).setMaxValue(365)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('nutzer')
        .setDescription('Nutzerdaten exportieren (GDPR / Compliance)')
        .addUserOption(opt =>
          opt.setName('user').setDescription('Ziel-User').setRequired(true)
        )
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator) as SlashCommandBuilder,
  adminOnly: true,

  execute: async (interaction: ChatInputCommandInteraction) => {
    await interaction.deferReply({ ephemeral: true });

    const sub = interaction.options.getSubcommand();

    switch (sub) {
      case 'pakete': {
        const targetUser = interaction.options.getUser('user', true);
        const dbUser = await prisma.user.findUnique({ where: { discordId: targetUser.id } });
        if (!dbUser) {
          await interaction.editReply({ content: '❌ User nicht in der Datenbank.' });
          return;
        }

        const packages = await prisma.package.findMany({
          where: { userId: dbUser.id },
          include: { files: true },
        });

        const exportData = JSON.stringify(packages, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2);
        const buffer = Buffer.from(exportData, 'utf-8');
        const attachment = new AttachmentBuilder(buffer, { name: `pakete_${targetUser.username}_${Date.now()}.json` });

        logAudit('DATA_EXPORT', 'ADMIN', {
          type: 'packages', targetUserId: dbUser.id, adminId: interaction.user.id,
        });

        await interaction.editReply({ content: `📦 Paketexport für ${targetUser.username}:`, files: [attachment] });
        break;
      }

      case 'logs': {
        const category = interaction.options.getString('kategorie') || 'ALL';
        const days = interaction.options.getInteger('tage') || 30;
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

        const where: Record<string, unknown> = { createdAt: { gte: since } };
        if (category !== 'ALL') {
          where.category = category;
        }

        const logs = await prisma.auditLog.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take: 10000,
        });

        const exportData = JSON.stringify(logs, null, 2);
        const buffer = Buffer.from(exportData, 'utf-8');
        const attachment = new AttachmentBuilder(buffer, { name: `audit_logs_${category}_${days}d_${Date.now()}.json` });

        logAudit('LOG_EXPORT', 'ADMIN', {
          category, days, count: logs.length, adminId: interaction.user.id,
        });

        await interaction.editReply({ content: `📋 ${logs.length} Log-Einträge exportiert (${category}, letzte ${days} Tage):`, files: [attachment] });
        break;
      }

      case 'nutzer': {
        const targetUser = interaction.options.getUser('user', true);
        const dbUser = await prisma.user.findUnique({
          where: { discordId: targetUser.id },
          include: {
            packages: true,
            uploads: true,
            downloads: true,
            moderationCases: true,
            appeals: true,
            levelData: true,
            xpRecords: true,
            giveawayEntries: true,
            pollVotes: true,
            gdprConsent: true,
          },
        });

        if (!dbUser) {
          await interaction.editReply({ content: '❌ User nicht in der Datenbank.' });
          return;
        }

        const exportData = JSON.stringify(dbUser, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2);
        const buffer = Buffer.from(exportData, 'utf-8');
        const attachment = new AttachmentBuilder(buffer, { name: `nutzerdaten_${targetUser.username}_${Date.now()}.json` });

        logAudit('GDPR_DATA_EXPORT', 'GDPR', {
          targetUserId: dbUser.id, adminId: interaction.user.id,
        });

        await interaction.editReply({ content: `📄 GDPR-Datenexport für ${targetUser.username}:`, files: [attachment] });
        break;
      }
    }
  },
};

export default adminExportCommand;
