import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
} from 'discord.js';
import { Command } from '../../types';
import prisma from '../../database/prisma';

/**
 * /admin-error-report — Fehlerberichte, Security-Events, Integritätswarnungen.
 * Developer-Bereich: Automatisierte Fehlerberichte, Monitoring, Alerting.
 */
const adminErrorReportCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('admin-error-report')
    .setDescription('Fehlerberichte und Security-Events anzeigen')
    .addStringOption(opt =>
      opt
        .setName('schwere')
        .setDescription('Schweregrad filtern')
        .setRequired(false)
        .addChoices(
          { name: 'Alle', value: 'ALL' },
          { name: 'Kritisch', value: 'CRITICAL' },
          { name: 'Hoch', value: 'HIGH' },
          { name: 'Mittel', value: 'MEDIUM' },
          { name: 'Niedrig', value: 'LOW' },
        )
    )
    .addBooleanOption(opt =>
      opt.setName('ungeloest').setDescription('Nur ungelöste Events').setRequired(false)
    )
    .addIntegerOption(opt =>
      opt.setName('anzahl').setDescription('Anzahl (max 25)').setRequired(false).setMinValue(1).setMaxValue(25)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator) as SlashCommandBuilder,
  adminOnly: true,

  execute: async (interaction: ChatInputCommandInteraction) => {
    await interaction.deferReply({ ephemeral: true });

    const severity = interaction.options.getString('schwere') || 'ALL';
    const unresolvedOnly = interaction.options.getBoolean('ungeloest') ?? true;
    const count = interaction.options.getInteger('anzahl') || 15;

    const where: Record<string, unknown> = {};
    if (severity !== 'ALL') {
      where.severity = severity;
    }
    if (unresolvedOnly) {
      where.isResolved = false;
    }

    const events = await prisma.securityEvent.findMany({
      where,
      take: count,
      orderBy: { createdAt: 'desc' },
      include: { user: true },
    });

    // Statistiken
    const [criticalCount, highCount, unresolvedCount] = await Promise.all([
      prisma.securityEvent.count({ where: { severity: 'CRITICAL', isResolved: false } }),
      prisma.securityEvent.count({ where: { severity: 'HIGH', isResolved: false } }),
      prisma.securityEvent.count({ where: { isResolved: false } }),
    ]);

    // Quarantänierte Pakete
    const quarantined = await prisma.package.count({ where: { status: 'QUARANTINED' } });
    // Invalide Uploads
    const invalidUploads = await prisma.upload.count({ where: { validationStatus: 'INVALID' } });

    if (events.length === 0 && quarantined === 0 && invalidUploads === 0) {
      await interaction.editReply({ content: '✅ Keine Fehler oder Security-Events gefunden.' });
      return;
    }

    const lines = events.map((e: any) => {
      const severityEmoji: string = ({ CRITICAL: '🔴', HIGH: '🟠', MEDIUM: '🟡', LOW: '🔵' } as Record<string, string>)[e.severity] || '⚪';
      const time = e.createdAt.toLocaleString('de-DE');
      const user = e.user ? `<@${e.user.discordId}>` : 'Unbekannt';
      const resolved = e.isResolved ? '✅' : '⏳';
      return `${severityEmoji} ${resolved} \`${time}\` — **${e.eventType}**\n   ${e.description}\n   User: ${user}`;
    });

    const embed = new EmbedBuilder()
      .setTitle('⚠️ Fehler- & Security-Report')
      .setColor(criticalCount > 0 ? 0xff0000 : highCount > 0 ? 0xff8c00 : 0xffff00)
      .setDescription(lines.join('\n\n') || 'Keine Events.')
      .addFields(
        { name: '🔴 Kritisch', value: `${criticalCount}`, inline: true },
        { name: '🟠 Hoch', value: `${highCount}`, inline: true },
        { name: '⏳ Ungelöst', value: `${unresolvedCount}`, inline: true },
        { name: '🔒 Quarantäne', value: `${quarantined} Pakete`, inline: true },
        { name: '❌ Invalide Uploads', value: `${invalidUploads}`, inline: true },
      )
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  },
};

export default adminErrorReportCommand;
