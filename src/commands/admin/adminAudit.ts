import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
  AttachmentBuilder,
} from 'discord.js';
import { Command } from '../../types';
import prisma from '../../database/prisma';

/**
 * /admin-audit [filter] — Audit-Log-Analyse, Compliance-Check.
 * Developer-Bereich: Audit-Log mit Filter, Export, Analyse.
 */
const adminAuditCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('admin-audit')
    .setDescription('Audit-Log-Analyse und Compliance-Check')
    .addSubcommand(sub =>
      sub
        .setName('suchen')
        .setDescription('Audit-Logs durchsuchen')
        .addStringOption(opt =>
          opt.setName('aktion').setDescription('Aktionstyp (z.B. UPLOAD, LOGIN)').setRequired(false)
        )
        .addStringOption(opt =>
          opt
            .setName('kategorie')
            .setDescription('Kategorie')
            .setRequired(false)
            .addChoices(
              { name: 'Auth', value: 'AUTH' },
              { name: 'Registration', value: 'REGISTRATION' },
              { name: 'Upload', value: 'UPLOAD' },
              { name: 'Download', value: 'DOWNLOAD' },
              { name: 'Moderation', value: 'MODERATION' },
              { name: 'Security', value: 'SECURITY' },
              { name: 'Admin', value: 'ADMIN' },
              { name: 'GDPR', value: 'GDPR' },
            )
        )
        .addUserOption(opt =>
          opt.setName('user').setDescription('Aktionen eines bestimmten Users').setRequired(false)
        )
        .addIntegerOption(opt =>
          opt.setName('tage').setDescription('Letzten X Tage').setRequired(false).setMinValue(1).setMaxValue(365)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('volltext')
        .setDescription('Audit-Volltextsuche über action+details')
        .addStringOption(opt =>
          opt.setName('query').setDescription('Suchbegriff (case-insensitive)').setRequired(true)
        )
        .addIntegerOption(opt =>
          opt.setName('tage').setDescription('Letzten X Tage').setRequired(false).setMinValue(1).setMaxValue(365)
        )
        .addIntegerOption(opt =>
          opt.setName('limit').setDescription('Max Ergebnisse (1-50)').setRequired(false).setMinValue(1).setMaxValue(50)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('compliance')
        .setDescription('Compliance-Check durchführen')
    )
    .addSubcommand(sub =>
      sub
        .setName('export')
        .setDescription('Audit-Logs exportieren')
        .addIntegerOption(opt =>
          opt.setName('tage').setDescription('Letzten X Tage').setRequired(false).setMinValue(1).setMaxValue(365)
        )
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator) as SlashCommandBuilder,
  adminOnly: true,

  execute: async (interaction: ChatInputCommandInteraction) => {
    await interaction.deferReply({ ephemeral: true });

    const sub = interaction.options.getSubcommand();

    switch (sub) {
      case 'suchen': {
        const action = interaction.options.getString('aktion');
        const category = interaction.options.getString('kategorie');
        const targetUser = interaction.options.getUser('user');
        const days = interaction.options.getInteger('tage') || 7;

        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
        const where: Record<string, unknown> = { createdAt: { gte: since } };

        if (action) where.action = { contains: action, mode: 'insensitive' };
        if (category) where.category = category;
        if (targetUser) {
          const dbUser = await prisma.user.findUnique({ where: { discordId: targetUser.id } });
          if (dbUser) {
            where.OR = [{ actorId: dbUser.id }, { targetId: dbUser.id }];
          }
        }

        const logs = await prisma.auditLog.findMany({
          where,
          take: 20,
          orderBy: { createdAt: 'desc' },
          include: { actor: true, target: true },
        });

        if (logs.length === 0) {
          await interaction.editReply({ content: '📋 Keine Audit-Einträge gefunden.' });
          return;
        }

        const lines = logs.map((l: any) => {
          const t = l.createdAt.toLocaleString('de-DE');
          const actor = l.actor ? `<@${l.actor.discordId}>` : 'System';
          return `\`${t}\` **${l.action}** [${l.category}]\n   Akteur: ${actor}${l.isImmutable ? ' 🔒' : ''}`;
        });

        const embed = new EmbedBuilder()
          .setTitle('🔍 Audit-Suche')
          .setDescription(lines.join('\n\n'))
          .setColor(0x9b59b6)
          .setFooter({ text: `${logs.length} Ergebnisse • Letzte ${days} Tage` })
          .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
        break;
      }

      case 'volltext': {
        const query = interaction.options.getString('query', true).trim();
        const days = interaction.options.getInteger('tage') || 30;
        const limit = interaction.options.getInteger('limit') || 20;
        if (query.length < 2) {
          await interaction.editReply({ content: '❌ Suchbegriff zu kurz (min. 2 Zeichen).' });
          return;
        }
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
        // Volltextsuche via ILIKE auf action + details::text.
        // Trigram-Index (siehe Migration) macht das auch bei großen Tabellen schnell.
        const rows = await prisma.$queryRaw<Array<{
          id: string; action: string; category: string; createdAt: Date;
          actorId: string | null; targetId: string | null; details: unknown; isImmutable: boolean;
        }>>`
          SELECT id, action, category, "createdAt", "actorId", "targetId", details, "isImmutable"
          FROM "AuditLog"
          WHERE "createdAt" >= ${since}
            AND (action ILIKE ${'%' + query + '%'} OR details::text ILIKE ${'%' + query + '%'})
          ORDER BY "createdAt" DESC
          LIMIT ${limit}
        `;
        if (rows.length === 0) {
          await interaction.editReply({ content: `🔍 Keine Treffer für **${query}** in den letzten ${days} Tagen.` });
          return;
        }
        const lines = rows.map(r => {
          const t = new Date(r.createdAt).toLocaleString('de-DE');
          const detailsPreview = r.details ? JSON.stringify(r.details).slice(0, 120) : '';
          return `\`${t}\` **${r.action}** [${r.category}]${r.isImmutable ? ' 🔒' : ''}\n  ${detailsPreview ? '`' + detailsPreview + '`' : ''}`;
        });
        const embed = new EmbedBuilder()
          .setTitle(`🔎 Volltextsuche: "${query.slice(0, 40)}"`)
          .setDescription(lines.join('\n\n').slice(0, 4000))
          .setColor(0x9b59b6)
          .setFooter({ text: `${rows.length} Ergebnisse • Letzte ${days} Tage` })
          .setTimestamp();
        await interaction.editReply({ embeds: [embed] });
        break;
      }

      case 'compliance': {
        // DSGVO und Sicherheits-Compliance-Checks
        const [
          usersWithoutConsent,
          pendingDeletions,
          expiredSessions,
          expiredOtps,
          orphanedData,
        ] = await Promise.all([
          prisma.user.count({ where: { gdprConsent: null } }),
          prisma.dataDeletionRequest.count({ where: { status: 'PENDING' } }),
          prisma.session.count({ where: { expiresAt: { lt: new Date() }, isActive: true } }),
          prisma.oneTimePassword.count({ where: { expiresAt: { lt: new Date() }, isUsed: false, isRevoked: false } }),
          prisma.upload.count({ where: { isDeleted: true, deletedAt: { lt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) } } }),
        ]);

        const issues: string[] = [];
        if (usersWithoutConsent > 0) issues.push(`⚠️ **${usersWithoutConsent}** User ohne DSGVO-Einwilligung`);
        if (pendingDeletions > 0) issues.push(`⚠️ **${pendingDeletions}** ausstehende Löschanfragen`);
        if (expiredSessions > 0) issues.push(`⚠️ **${expiredSessions}** abgelaufene aktive Sessions`);
        if (expiredOtps > 0) issues.push(`⚠️ **${expiredOtps}** abgelaufene OTPs nicht widerrufen`);
        if (orphanedData > 0) issues.push(`⚠️ **${orphanedData}** gelöschte Dateien > 90 Tage (Aufbewahrung prüfen)`);

        const status = issues.length === 0 ? '✅ Alle Compliance-Checks bestanden!' : issues.join('\n');

        const embed = new EmbedBuilder()
          .setTitle('📋 Compliance-Check')
          .setDescription(status)
          .setColor(issues.length === 0 ? 0x00ff00 : 0xffcc00)
          .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
        break;
      }

      case 'export': {
        const days = interaction.options.getInteger('tage') || 30;
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

        const logs = await prisma.auditLog.findMany({
          where: { createdAt: { gte: since } },
          orderBy: { createdAt: 'desc' },
          take: 50000,
        });

        const data = JSON.stringify(logs, null, 2);
        const buffer = Buffer.from(data, 'utf-8');
        const attachment = new AttachmentBuilder(buffer, { name: `audit_export_${days}d_${Date.now()}.json` });

        await interaction.editReply({
          content: `📋 ${logs.length} Audit-Einträge exportiert (letzte ${days} Tage):`,
          files: [attachment],
        });
        break;
      }
    }
  },
};

export default adminAuditCommand;
