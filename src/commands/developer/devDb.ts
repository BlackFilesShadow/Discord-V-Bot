import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { Command } from '../../types';
import prisma from '../../database/prisma';
import { logger } from '../../utils/logger';

/**
 * /dev-db – Developer-Datenbank-Management.
 * Direktzugriff auf DB-Operationen (Passwort-geschützt).
 */
const devDbCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('dev-db')
    .setDescription('🔒 Datenbank-Management für Entwickler')
    .addStringOption(opt =>
      opt
        .setName('action')
        .setDescription('Aktion')
        .setRequired(true)
        .addChoices(
          { name: 'Tabellen-Übersicht', value: 'tables' },
          { name: 'User-Suche', value: 'user-search' },
          { name: 'Paket-Suche', value: 'pkg-search' },
          { name: 'Cleanup (verwaiste Daten)', value: 'cleanup' },
        )
    )
    .addStringOption(opt =>
      opt
        .setName('query')
        .setDescription('Suchbegriff (für User-/Paket-Suche)')
        .setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator) as SlashCommandBuilder,
  devOnly: true,

  execute: async (interaction: ChatInputCommandInteraction) => {
    await interaction.deferReply({ ephemeral: true });

    const action = interaction.options.getString('action', true);
    const query = interaction.options.getString('query') || '';
    const embed = new EmbedBuilder().setColor(0x9b59b6).setTimestamp();

    switch (action) {
      case 'tables': {
        const [users, pkgs, uploads, logs, sessions, giveaways] = await Promise.all([
          prisma.user.count(),
          prisma.package.count(),
          prisma.upload.count(),
          prisma.auditLog.count(),
          prisma.session.count(),
          prisma.giveaway.count(),
        ]);

        embed.setTitle('📊 Datenbank-Übersicht').addFields(
          { name: 'Users', value: users.toString(), inline: true },
          { name: 'Packages', value: pkgs.toString(), inline: true },
          { name: 'Uploads', value: uploads.toString(), inline: true },
          { name: 'Audit Logs', value: logs.toString(), inline: true },
          { name: 'Sessions', value: sessions.toString(), inline: true },
          { name: 'Giveaways', value: giveaways.toString(), inline: true },
        );
        break;
      }

      case 'user-search': {
        if (!query) {
          await interaction.editReply({ content: '❌ Bitte einen Suchbegriff angeben (`query`).' });
          return;
        }

        const users = await prisma.user.findMany({
          where: {
            OR: [
              { username: { contains: query, mode: 'insensitive' } },
              { discordId: { contains: query } },
              { email: { contains: query, mode: 'insensitive' } },
            ],
          },
          take: 10,
          select: { id: true, discordId: true, username: true, role: true, isManufacturer: true, createdAt: true },
        });

        if (users.length === 0) {
          embed.setTitle('🔍 User-Suche').setDescription(`Keine Ergebnisse für "${query}".`);
        } else {
          embed.setTitle(`🔍 User-Suche: ${users.length} Treffer`);
          for (const u of users) {
            embed.addFields({
              name: `${u.username} (${u.role})`,
              value: `ID: \`${u.discordId}\` | Hersteller: ${u.isManufacturer ? '✅' : '❌'} | Seit: ${u.createdAt.toLocaleDateString('de-DE')}`,
              inline: false,
            });
          }
        }
        break;
      }

      case 'pkg-search': {
        if (!query) {
          await interaction.editReply({ content: '❌ Bitte einen Suchbegriff angeben (`query`).' });
          return;
        }

        const pkgs = await prisma.package.findMany({
          where: {
            name: { contains: query, mode: 'insensitive' },
          },
          take: 10,
          include: {
            user: { select: { username: true } },
            _count: { select: { files: true } },
          },
        });

        if (pkgs.length === 0) {
          embed.setTitle('🔍 Paket-Suche').setDescription(`Keine Ergebnisse für "${query}".`);
        } else {
          embed.setTitle(`🔍 Paket-Suche: ${pkgs.length} Treffer`);
          for (const p of pkgs) {
            embed.addFields({
              name: `${p.name} (${p.user.username})`,
              value: `Dateien: ${p._count.files} | Gelöscht: ${p.isDeleted ? '🗑️' : '❌'} | Erstellt: ${p.createdAt.toLocaleDateString('de-DE')}`,
              inline: false,
            });
          }
        }
        break;
      }

      case 'cleanup': {
        // Verwaiste Sessions bereinigen
        const expiredSessions = await prisma.session.deleteMany({
          where: { expiresAt: { lt: new Date() } },
        });

        // Verwaiste OTPs bereinigen
        const expiredOTPs = await prisma.oneTimePassword.deleteMany({
          where: { expiresAt: { lt: new Date() } },
        });

        embed.setTitle('🧹 Cleanup abgeschlossen').addFields(
          { name: 'Abgelaufene Sessions', value: `${expiredSessions.count} gelöscht`, inline: true },
          { name: 'Abgelaufene OTPs', value: `${expiredOTPs.count} gelöscht`, inline: true },
        );

        logger.info(`Dev-Cleanup: ${expiredSessions.count} Sessions, ${expiredOTPs.count} OTPs von ${interaction.user.tag}`);
        break;
      }
    }

    await interaction.editReply({ embeds: [embed] });
  },
};

export default devDbCommand;
