import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
  MessageFlags,
} from 'discord.js';
import { Command } from '../../types';
import prisma from '../../database/prisma';
import os from 'os';
import { config } from '../../config';
import fs from 'fs/promises';
import { constants as fsConstants } from 'fs';
import { formatBytes } from '../../utils/embedDesign';

/**
 * /admin-monitor — Live-Monitoring aller Systemkomponenten.
 * Developer-Bereich: Systemstatus, Speicher, Auslastung, Fehler, Warnungen, Security-Alerts, Integritätsstatus.
 */
const adminMonitorCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('admin-monitor')
    .setDescription('Live-Monitoring aller Systemkomponenten')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator) as SlashCommandBuilder,
  adminOnly: true,

  execute: async (interaction: ChatInputCommandInteraction) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // Datenbank prüfen
    let dbStatus = '✅ Verbunden';
    let dbLatency = 0;
    try {
      const start = Date.now();
      await prisma.$queryRaw`SELECT 1`;
      dbLatency = Date.now() - start;
    } catch {
      dbStatus = '❌ Nicht erreichbar';
    }

    // System-Metriken
    const uptime = process.uptime();
    const memUsage = process.memoryUsage();
    const loadAvg = os.loadavg();
    const cpuCount = os.cpus().length;
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMemPercent = Math.round(((totalMem - freeMem) / totalMem) * 100);

    // Upload-Verzeichnis (async)
    let uploadDirExists = false;
    let uploadDirWritable = false;
    try {
      await fs.access(config.upload.dir, fsConstants.F_OK);
      uploadDirExists = true;
      try {
        await fs.access(config.upload.dir, fsConstants.W_OK);
        uploadDirWritable = true;
      } catch { /* not writable */ }
    } catch { /* missing */ }

    // Aktive Echtzeit-Tasks
    const [activeGiveaways, activePolls, activeFeeds, activeSessions, unresolvedSecurity] = await Promise.all([
      prisma.giveaway.count({ where: { status: 'ACTIVE' } }),
      prisma.poll.count({ where: { status: 'ACTIVE' } }),
      prisma.feed.count({ where: { isActive: true } }),
      prisma.session.count({ where: { isActive: true, expiresAt: { gt: new Date() } } }),
      prisma.securityEvent.count({ where: { isResolved: false, severity: { in: ['CRITICAL', 'HIGH'] } } }),
    ]);

    // Bot-Status
    const client = interaction.client;
    const guilds = client.guilds.cache.size;
    const users = client.guilds.cache.reduce((acc, g) => acc + g.memberCount, 0);
    const ping = client.ws.ping;

    // Health-Score berechnen
    let healthScore = 100;
    if (dbStatus !== '✅ Verbunden') healthScore -= 30;
    if (dbLatency > 500) healthScore -= 10;
    if (usedMemPercent > 90) healthScore -= 20;
    if (loadAvg[0] > cpuCount * 2) healthScore -= 15;
    if (unresolvedSecurity > 0) healthScore -= 10;
    if (!uploadDirWritable) healthScore -= 10;

    const healthEmoji = healthScore >= 80 ? '🟢' : healthScore >= 50 ? '🟡' : '🔴';

    const embed = new EmbedBuilder()
      .setTitle(`${healthEmoji} System-Monitor (Health: ${healthScore}%)`)
      .setColor(healthScore >= 80 ? 0x00ff00 : healthScore >= 50 ? 0xffcc00 : 0xff0000)
      .addFields(
        {
          name: '🤖 Bot',
          value: `Ping: **${ping}ms**\nGuilds: **${guilds}**\nUser: **${users}**\nUptime: **${formatUptime(uptime)}**`,
          inline: true,
        },
        {
          name: '🗄️ Datenbank',
          value: `Status: ${dbStatus}\nLatenz: **${dbLatency}ms**`,
          inline: true,
        },
        {
          name: '🖥️ System',
          value: `CPU Load: **${loadAvg[0].toFixed(2)}** / ${cpuCount} Cores\nRAM: **${usedMemPercent}%** (${formatBytes(totalMem - freeMem)} / ${formatBytes(totalMem)})\nNode Heap: **${formatBytes(memUsage.heapUsed)}**`,
          inline: true,
        },
        {
          name: '💾 Storage',
          value: `Upload-Dir: ${uploadDirExists ? '✅' : '❌'}\nSchreibbar: ${uploadDirWritable ? '✅' : '❌'}`,
          inline: true,
        },
        {
          name: '⚡ Aktive Tasks',
          value: `Giveaways: **${activeGiveaways}**\nPolls: **${activePolls}**\nFeeds: **${activeFeeds}**\nSessions: **${activeSessions}**`,
          inline: true,
        },
        {
          name: '⚠️ Alerts',
          value: unresolvedSecurity > 0
            ? `🔴 **${unresolvedSecurity}** ungelöste kritische/hohe Security-Events`
            : '✅ Keine aktiven Alerts',
          inline: true,
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
  const s = Math.floor(seconds % 60);
  return `${d}d ${h}h ${m}m ${s}s`;
}

export default adminMonitorCommand;
