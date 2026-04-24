import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import os from 'os';
import { Command } from '../../types';
import prisma from '../../database/prisma';
import { Colors, Brand, vEmbed, formatBytes } from '../../utils/embedDesign';

/**
 * /status — kompakter Bot-Health-Report fuer alle User.
 * Schnell und ohne sensible Infos. Detaillierte Diagnostik in /dev-eval.
 */

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  parts.push(`${sec}s`);
  return parts.join(' ');
}

const statusCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('status')
    .setDescription('Zeigt Bot-Status, Uptime und Health-Info'),
  cooldown: 10,
  execute: async (interaction: ChatInputCommandInteraction) => {
    await interaction.deferReply({ ephemeral: true });

    const client = interaction.client;
    const uptimeMs = client.uptime ?? 0;
    const wsPing = client.ws.ping;
    const guilds = client.guilds.cache.size;

    // DB-Roundtrip messen
    let dbMs: number | null = null;
    let dbOk = false;
    try {
      const t = Date.now();
      await prisma.$queryRaw`SELECT 1`;
      dbMs = Date.now() - t;
      dbOk = true;
    } catch {
      dbOk = false;
    }

    const mem = process.memoryUsage();
    const heapMb = mem.heapUsed / 1024 / 1024;

    const overall =
      !dbOk ? Colors.Error :
      (wsPing >= 0 && wsPing < 200 && (dbMs ?? 0) < 200) ? Colors.Success :
      Colors.Warning;

    const embed = vEmbed(overall)
      .setTitle('📊 Bot-Status')
      .setDescription(Brand.divider)
      .addFields(
        { name: '🟢 Status', value: dbOk ? 'Operational' : 'Degraded', inline: true },
        { name: '⏱️ Uptime', value: formatUptime(uptimeMs), inline: true },
        { name: '🌐 Server', value: `${guilds}`, inline: true },
        { name: '📡 WebSocket', value: wsPing < 0 ? 'n/a' : `${wsPing} ms`, inline: true },
        { name: '🗄️ Datenbank', value: dbOk ? `\`${dbMs} ms\`` : '❌ offline', inline: true },
        { name: '💾 Heap', value: `${heapMb.toFixed(1)} MB`, inline: true },
        { name: '🖥️ Node', value: process.version, inline: true },
        { name: '🐧 OS', value: `${os.type()} ${os.release().split('-')[0]}`, inline: true },
        { name: '📦 Mem-Frei', value: formatBytes(os.freemem()), inline: true },
      )
      .setFooter({ text: `${Brand.footerText} • Health-Report` });

    await interaction.editReply({ embeds: [embed] });
  },
};

export default statusCommand;
