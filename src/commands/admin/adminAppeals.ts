import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
  MessageFlags,
} from 'discord.js';
import { AppealStatus } from '@prisma/client';
import { Command } from '../../types';
import prisma from '../../database/prisma';
import { logAudit, logger } from '../../utils/logger';

/**
 * /admin-appeals — Übersicht und Bearbeitung von Moderations-Appeals.
 * Developer-Bereich: Übersicht aller Appeals, Eskalationsstufen.
 */
const adminAppealsCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('admin-appeals')
    .setDescription('Moderations-Appeals verwalten')
    .addSubcommand(sub =>
      sub
        .setName('liste')
        .setDescription('Offene Appeals anzeigen')
        .addStringOption(opt =>
          opt
            .setName('status')
            .setDescription('Status filtern')
            .setRequired(false)
            .addChoices(
              { name: 'Ausstehend', value: 'PENDING' },
              { name: 'Genehmigt', value: 'APPROVED' },
              { name: 'Abgelehnt', value: 'DENIED' },
              { name: 'Eskaliert', value: 'ESCALATED' },
            )
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('genehmigen')
        .setDescription('Appeal genehmigen')
        .addStringOption(opt =>
          opt.setName('appeal-id').setDescription('Appeal-ID').setRequired(true)
        )
        .addStringOption(opt =>
          opt.setName('notiz').setDescription('Admin-Notiz').setRequired(false)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('ablehnen')
        .setDescription('Appeal ablehnen')
        .addStringOption(opt =>
          opt.setName('appeal-id').setDescription('Appeal-ID').setRequired(true)
        )
        .addStringOption(opt =>
          opt.setName('notiz').setDescription('Admin-Notiz').setRequired(false)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('eskalieren')
        .setDescription('Appeal an höhere Instanz eskalieren')
        .addStringOption(opt =>
          opt.setName('appeal-id').setDescription('Appeal-ID').setRequired(true)
        )
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator) as SlashCommandBuilder,
  adminOnly: true,

  execute: async (interaction: ChatInputCommandInteraction) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.editReply({ content: '❌ Dieser Befehl ist nur in einem Server verfügbar.' });
      return;
    }

    const sub = interaction.options.getSubcommand();

    switch (sub) {
      case 'liste': {
        const status = (interaction.options.getString('status') || 'PENDING') as AppealStatus;
        const appeals = await prisma.appeal.findMany({
          where: { status, case: { guildId } },
          take: 15,
          orderBy: { createdAt: 'desc' },
          include: {
            user: true,
            case: {
              include: { moderator: true },
            },
          },
        });

        if (appeals.length === 0) {
          await interaction.editReply({ content: `📋 Keine Appeals mit Status \`${status}\`.` });
          return;
        }

        const lines = appeals.map((a, i: number) => {
          const time = a.createdAt.toLocaleString('de-DE');
          return `**${i + 1}.** ID: \`${a.id}\`\n` +
            `   User: <@${a.user.discordId}> | Fall #${a.case.caseNumber} (${a.case.action})\n` +
            `   Moderator: <@${a.case.moderator.discordId}>\n` +
            `   Grund: ${a.reason.substring(0, 100)}\n` +
            `   Erstellt: ${time}`;
        });

        const embed = new EmbedBuilder()
          .setTitle(`📩 Appeals (${status})`)
          .setDescription(lines.join('\n\n'))
          .setColor(0xe67e22)
          .setFooter({ text: `${appeals.length} Ergebnisse` })
          .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
        break;
      }

      case 'genehmigen': {
        const appealId = interaction.options.getString('appeal-id', true);
        const note = interaction.options.getString('notiz') || '';

        const appeal = await prisma.appeal.findFirst({
          where: { id: appealId, case: { guildId } },
          include: { case: true, user: true },
        });

        if (!appeal || appeal.status !== 'PENDING') {
          await interaction.editReply({ content: '❌ Appeal nicht gefunden oder bereits bearbeitet.' });
          return;
        }

        // Atomar: Appeal genehmigen + Moderationsfall aufheben
        await prisma.$transaction([
          prisma.appeal.update({
            where: { id: appealId },
            data: {
              status: 'APPROVED',
              reviewedBy: interaction.user.id,
              reviewNote: note,
              reviewedAt: new Date(),
            },
          }),
          prisma.moderationCase.update({
            where: { id: appeal.caseId },
            data: { isActive: false, revokedAt: new Date(), revokedBy: interaction.user.id },
          }),
        ]);

        // User per DM benachrichtigen
        try {
          const user = await interaction.client.users.fetch(appeal.user.discordId);
          await user.send(`✅ Dein Appeal für Fall #${appeal.case.caseNumber} wurde **genehmigt**.\n${note ? `Notiz: ${note}` : ''}`);
        } catch {
          logger.warn(`Konnte DM für Appeal nicht senden.`);
        }

        logAudit('APPEAL_APPROVED', 'APPEAL', {
          appealId, caseNumber: appeal.case.caseNumber, adminId: interaction.user.id,
        });

        await interaction.editReply({ content: `✅ Appeal genehmigt. Fall #${appeal.case.caseNumber} wurde aufgehoben.` });
        break;
      }

      case 'ablehnen': {
        const appealId = interaction.options.getString('appeal-id', true);
        const note = interaction.options.getString('notiz') || '';

        const appeal = await prisma.appeal.findFirst({
          where: { id: appealId, case: { guildId } },
          include: { case: true, user: true },
        });

        if (!appeal || appeal.status !== 'PENDING') {
          await interaction.editReply({ content: '❌ Appeal nicht gefunden oder bereits bearbeitet.' });
          return;
        }

        await prisma.appeal.update({
          where: { id: appealId },
          data: {
            status: 'DENIED',
            reviewedBy: interaction.user.id,
            reviewNote: note,
            reviewedAt: new Date(),
          },
        });

        try {
          const user = await interaction.client.users.fetch(appeal.user.discordId);
          await user.send(`❌ Dein Appeal für Fall #${appeal.case.caseNumber} wurde **abgelehnt**.${note ? `\nGrund: ${note}` : ''}`);
        } catch {
          logger.warn(`Konnte DM für Appeal nicht senden.`);
        }

        logAudit('APPEAL_DENIED', 'APPEAL', {
          appealId, caseNumber: appeal.case.caseNumber, adminId: interaction.user.id,
        });

        await interaction.editReply({ content: `❌ Appeal abgelehnt. Fall #${appeal.case.caseNumber} bleibt aktiv.` });
        break;
      }

      case 'eskalieren': {
        const appealId = interaction.options.getString('appeal-id', true);

        const appeal = await prisma.appeal.findFirst({
          where: { id: appealId, case: { guildId } },
          include: { case: true, user: true },
        });

        if (!appeal || appeal.status !== 'PENDING') {
          await interaction.editReply({ content: '❌ Appeal nicht gefunden oder bereits bearbeitet.' });
          return;
        }

        // Atomar: Appeal eskalieren + Eskalationsstufe erhöhen
        await prisma.$transaction([
          prisma.appeal.update({
            where: { id: appealId },
            data: { status: 'ESCALATED' },
          }),
          prisma.moderationCase.update({
            where: { id: appeal.caseId },
            data: { escalationLevel: { increment: 1 } },
          }),
        ]);

        // User per DM benachrichtigen
        try {
          const user = await interaction.client.users.fetch(appeal.user.discordId);
          await user.send(`⬆️ Dein Appeal für Fall #${appeal.case.caseNumber} wurde **eskaliert** und wird durch eine höhere Instanz geprüft.`);
        } catch {
          logger.warn(`Konnte DM für eskalierten Appeal nicht senden.`);
        }

        logAudit('APPEAL_ESCALATED', 'APPEAL', {
          appealId, caseNumber: appeal.case.caseNumber, adminId: interaction.user.id,
        });

        await interaction.editReply({ content: `⬆️ Appeal eskaliert. Fall #${appeal.case.caseNumber} wurde an höhere Instanz weitergeleitet.` });
        break;
      }
    }
  },
};

export default adminAppealsCommand;
