import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
  MessageFlags,
} from 'discord.js';
import { Prisma } from '@prisma/client';
import { Command } from '../../types';
import prisma from '../../database/prisma';
import { safeEmbedDescription } from '../../utils/embedSanitize';

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
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const filter = interaction.options.getString('filter') || 'ALL';
    const count = interaction.options.getInteger('anzahl') || 15;
    const targetUser = interaction.options.getUser('user');

    const where: Prisma.AuditLogWhereInput = {};
    if (filter !== 'ALL') {
      where.category = filter as Prisma.AuditLogWhereInput['category'];
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

    const lines = logs.map((log) => {
      const time = log.createdAt.toLocaleString('de-DE');
      const actor = log.actor ? `<@${log.actor.discordId}>` : 'System';
      const target = log.target ? ` → <@${log.target.discordId}>` : '';
      const categoryEmoji = getCategoryEmoji(log.category);
      return `${categoryEmoji} \`${time}\` ${actor}${target}\n   **${log.action}** (${log.category})`;
    });

    const embed = new EmbedBuilder()
      .setTitle(`📋 Audit-Logs (${filter})`)
      // P0: Action/Category aus DB koennten in Zukunft User-getrieben sein → sanitisieren.
      .setDescription(safeEmbedDescription(lines.join('\n\n')))
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
