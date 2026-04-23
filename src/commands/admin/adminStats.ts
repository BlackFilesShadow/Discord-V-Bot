import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
} from 'discord.js';
import { Command } from '../../types';
import prisma from '../../database/prisma';
import os from 'os';
import fs from 'fs';
import { config } from '../../config';

/**
 * /admin-stats — System-, Nutzungs-, Sicherheitsstatistiken.
 * Developer-Bereich: Systemstatus, Auslastung, Fehler, Warnungen.
 */
const adminStatsCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('admin-stats')
    .setDescription('System- und Nutzungsstatistiken anzeigen')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator) as SlashCommandBuilder,
  adminOnly: true,

  execute: async (interaction: ChatInputCommandInteraction) => {
    await interaction.deferReply({ ephemeral: true });

    // Guild-Trennung: Moderationszahlen nur f\u00fcr aktuelle Guild,
    // globale Daten (User, Pakete, Uploads, Downloads) bleiben global.
    const guildId = interaction.guildId;

    // Nutzungsstatistiken
    const [
      totalUsers,
      manufacturers,
      totalPackages,
      activePackages,
      quarantinedPackages,
      totalUploads,
      totalDownloads,
      totalCases,
      activeCases,
      pendingAppeals,
      activeGiveaways,
      totalPolls,
      securityEvents,
      unresolvedSecEvents,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { isManufacturer: true } }),
      prisma.package.count(),
      prisma.package.count({ where: { status: 'ACTIVE' } }),
      prisma.package.count({ where: { status: 'QUARANTINED' } }),
      prisma.upload.count(),
      prisma.download.count(),
      prisma.moderationCase.count({ where: guildId ? { guildId } : {} }),
      prisma.moderationCase.count({ where: { isActive: true, ...(guildId ? { guildId } : {}) } }),
      prisma.appeal.count({ where: { status: 'PENDING', ...(guildId ? { case: { guildId } } : {}) } }),
      prisma.giveaway.count({ where: { status: 'ACTIVE' } }),
      prisma.poll.count(),
      prisma.securityEvent.count(),
      prisma.securityEvent.count({ where: { isResolved: false } }),
    ]);

    // Systemstats
    const uptime = process.uptime();
    const memUsage = process.memoryUsage();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const cpus = os.cpus();

    // Upload-Verzeichnisgröße
    let uploadDirSize = 0;
    try {
      uploadDirSize = getDirSize(config.upload.dir);
    } catch { /* ignore */ }

    const embed = new EmbedBuilder()
      .setTitle('📊 System- & Nutzungsstatistiken')
      .setColor(0x3498db)
      .addFields(
        {
          name: '👥 Nutzer',
          value: `Gesamt: **${totalUsers}**\nHersteller: **${manufacturers}**`,
          inline: true,
        },
        {
          name: '📦 Pakete',
          value: `Gesamt: **${totalPackages}**\nAktiv: **${activePackages}**\nQuarantäne: **${quarantinedPackages}**`,
          inline: true,
        },
        {
          name: '📤📥 Transfers',
          value: `Uploads: **${totalUploads}**\nDownloads: **${totalDownloads}**`,
          inline: true,
        },
        {
          name: '🛡️ Moderation',
          value: `Fälle: **${totalCases}**\nAktiv: **${activeCases}**\nOffene Appeals: **${pendingAppeals}**`,
          inline: true,
        },
        {
          name: '🎉 Community',
          value: `Aktive Giveaways: **${activeGiveaways}**\nUmfragen: **${totalPolls}**`,
          inline: true,
        },
        {
          name: '🔒 Security',
          value: `Events: **${securityEvents}**\nUngelöst: **${unresolvedSecEvents}**`,
          inline: true,
        },
        {
          name: '🖥️ System',
          value: `Uptime: **${formatUptime(uptime)}**\nRAM: **${formatBytes(memUsage.heapUsed)}** / **${formatBytes(totalMem)}**\nFrei: **${formatBytes(freeMem)}**\nCPUs: **${cpus.length}x ${cpus[0]?.model || 'N/A'}**`,
          inline: false,
        },
        {
          name: '💾 Storage',
          value: `Upload-Verzeichnis: **${formatBytes(uploadDirSize)}**\nNode.js Heap: **${formatBytes(memUsage.heapTotal)}**`,
          inline: false,
        },
      )
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  },
};

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${d}d ${h}h ${m}m`;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

function getDirSize(dirPath: string): number {
  if (!fs.existsSync(dirPath)) return 0;
  let total = 0;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = `${dirPath}/${entry.name}`;
    if (entry.isDirectory()) {
      total += getDirSize(fullPath);
    } else {
      total += fs.statSync(fullPath).size;
    }
  }
  return total;
}

export default adminStatsCommand;
