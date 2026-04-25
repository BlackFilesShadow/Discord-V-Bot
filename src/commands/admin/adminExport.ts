import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  AttachmentBuilder,
} from 'discord.js';
import { Command } from '../../types';
import prisma from '../../database/prisma';
import { logAudit } from '../../utils/logger';
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

        // Streaming-Export per Cursor-Pagination, damit auch >10k Eintraege
        // ohne OOM verarbeitet werden. Wir schreiben direkt in eine temporaere
        // Datei und haengen sie an, bzw. bieten Download-URL an wenn die
        // Discord-Attachment-Grenze (Default 25 MB) ueberschritten wird.
        const tmpDir = path.join(config.upload.dir, '_exports');
        try { fs.mkdirSync(tmpDir, { recursive: true }); } catch { /* ok */ }
        const fileName = `audit_logs_${category}_${days}d_${Date.now()}.json`;
        const tmpPath = path.join(tmpDir, fileName);
        const out = fs.createWriteStream(tmpPath, { encoding: 'utf-8' });
        const writeJson = (s: string) => new Promise<void>((res, rej) => {
          if (out.write(s)) return res();
          out.once('drain', () => res());
          out.once('error', rej);
        });

        const PAGE = 1000;
        let cursor: string | undefined;
        let total = 0;
        let first = true;
        await writeJson('[');
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const page: any[] = await prisma.auditLog.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            take: PAGE,
            ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
          });
          if (page.length === 0) break;
          for (const row of page) {
            await writeJson(
              (first ? '\n  ' : ',\n  ') +
                JSON.stringify(row, (_, v) => (typeof v === 'bigint' ? v.toString() : v)),
            );
            first = false;
          }
          total += page.length;
          cursor = page[page.length - 1].id;
          if (page.length < PAGE) break;
        }
        await writeJson('\n]\n');
        await new Promise<void>((res) => out.end(() => res()));

        const stat = fs.statSync(tmpPath);
        const MAX_DISCORD = 25 * 1024 * 1024; // konservativ (Boost-Tier-1)
        logAudit('LOG_EXPORT', 'ADMIN', {
          category, days, count: total, bytes: stat.size, adminId: interaction.user.id,
        });

        if (stat.size > MAX_DISCORD) {
          await interaction.editReply({
            content:
              `📋 ${total} Log-Eintraege exportiert (${category}, letzte ${days} Tage).\n` +
              `⚠️ Datei ist ${(stat.size / 1024 / 1024).toFixed(1)} MB und uebersteigt das Discord-Limit.\n` +
              `Pfad auf dem Server: \`${tmpPath}\`\n` +
              `Bitte per SSH/Dashboard abholen.`,
          });
        } else {
          const attachment = new AttachmentBuilder(tmpPath, { name: fileName });
          await interaction.editReply({
            content: `📋 ${total} Log-Eintraege exportiert (${category}, letzte ${days} Tage):`,
            files: [attachment],
          });
          // Cleanup nach erfolgreicher Auslieferung (best effort)
          fs.unlink(tmpPath, () => {});
        }
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
