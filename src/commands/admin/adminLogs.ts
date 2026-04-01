import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
} from 'discord.js';
import { Command } from '../../types';
import prisma from '../../database/prisma';
import fs from 'fs';
import path from 'path';

/**
 * /admin-logs [filter] — Live-Log-Stream mit Filteroptionen.
 * Developer-Bereich: Live-Logs aller Aktionen.
 */
const adminLogsCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('admin-logs')
    .setDescription('Live-Logs und Aktionsprotokoll anzeigen')
    .addStringOption(opt =>
      opt
        .setName('filter')
        .setDescription('Log-Kategorie filtern')
        .setRequired(false)
        .addChoices(
          { name: 'Alle', value: 'ALL' },
          { name: 'Security', value: 'SECURITY' },
          { name: 'Upload', value: 'UPLOAD' },
          { name: 'Download', value: 'DOWNLOAD' },
          { name: 'Moderation', value: 'MODERATION' },
          { name: 'Auth', value: 'AUTH' },
          { name: 'System', value: 'SYSTEM' },
          { name: 'GDPR', value: 'GDPR' },
        )
    )
    .addIntegerOption(opt =>
      opt.setName('anzahl').setDescription('Anzahl der Einträge (max 25)').setRequired(false).setMinValue(1).setMaxValue(25)
    )
    .addUserOption(opt =>
      opt.setName('user').setDescription('Logs eines bestimmten Users').setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator) as SlashCommandBuilder,
  adminOnly: true,

  execute: async (interaction: ChatInputCommandInteraction) => {
    await interaction.deferReply({ ephemeral: true });

    const filter = interaction.options.getString('filter') || 'ALL';
    const count = interaction.options.getInteger('anzahl') || 15;
    const targetUser = interaction.options.getUser('user');

    const where: Record<string, unknown> = {};
    if (filter !== 'ALL') {
      where.category = filter;
    }
    if (targetUser) {
      const dbUser = await prisma.user.findUnique({ where: { discordId: targetUser.id } });
      if (dbUser) {
        where.OR = [{ actorId: dbUser.id }, { targetId: dbUser.id }];
      }
    }

    const logs = await prisma.auditLog.findMany({
      where,
      take: count,
      orderBy: { createdAt: 'desc' },
      include: {
        actor: true,
        target: true,
      },
    });

    if (logs.length === 0) {
      await interaction.editReply({ content: '📋 Keine Log-Einträge gefunden.' });
      return;
    }

    const lines = logs.map((log: any) => {
      const time = log.createdAt.toLocaleString('de-DE');
      const actor = log.actor ? `<@${log.actor.discordId}>` : 'System';
      const target = log.target ? ` → <@${log.target.discordId}>` : '';
      const categoryEmoji = getCategoryEmoji(log.category);
      return `${categoryEmoji} \`${time}\` ${actor}${target}\n   **${log.action}** (${log.category})`;
    });

    const embed = new EmbedBuilder()
      .setTitle(`📋 Audit-Logs (${filter})`)
      .setDescription(lines.join('\n\n'))
      .setColor(0x9b59b6)
      .setFooter({ text: `${logs.length} Einträge angezeigt` })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  },
};

function getCategoryEmoji(category: string): string {
  const map: Record<string, string> = {
    AUTH: '🔐', REGISTRATION: '📝', UPLOAD: '📤', DOWNLOAD: '📥',
    MODERATION: '🛡️', GIVEAWAY: '🎉', LEVEL: '⭐', ROLE: '👤',
    POLL: '📊', SECURITY: '🔒', ADMIN: '⚙️', SYSTEM: '🖥️',
    CONFIG: '⚙️', GDPR: '🔏', AI: '🤖', FEED: '📡', APPEAL: '📩',
  };
  return map[category] || '📄';
}

export default adminLogsCommand;
