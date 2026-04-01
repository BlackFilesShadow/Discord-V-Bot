import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
} from 'discord.js';
import { Command } from '../../types';
import prisma from '../../database/prisma';
import { logger } from '../../utils/logger';
import { logAudit } from '../../utils/logger';

/**
 * /dev-admin – Admin-Verwaltung (nur für Developer).
 * - add: User als Admin eintragen
 * - remove: Admin-Rolle entziehen
 * - list: Alle Admins anzeigen
 */
const devAdminCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('dev-admin')
    .setDescription('🔒 Admin-Verwaltung (Developer)')
    .addSubcommand(sub =>
      sub
        .setName('add')
        .setDescription('User als Admin eintragen')
        .addUserOption(opt =>
          opt.setName('user').setDescription('User der Admin werden soll').setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('remove')
        .setDescription('Admin-Rolle entziehen')
        .addUserOption(opt =>
          opt.setName('user').setDescription('User dem die Admin-Rolle entzogen wird').setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('list')
        .setDescription('Alle Admins anzeigen')
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator) as SlashCommandBuilder,
  devOnly: true,

  execute: async (interaction: ChatInputCommandInteraction) => {
    await interaction.deferReply({ ephemeral: true });

    const sub = interaction.options.getSubcommand();

    switch (sub) {
      case 'add': {
        const targetUser = interaction.options.getUser('user', true);

        // User in DB suchen oder erstellen
        let dbUser = await prisma.user.findUnique({
          where: { discordId: targetUser.id },
        });

        if (!dbUser) {
          dbUser = await prisma.user.create({
            data: {
              discordId: targetUser.id,
              username: targetUser.username,
              discriminator: targetUser.discriminator || '0',
              role: 'ADMIN',
            },
          });
        } else {
          if (['ADMIN', 'SUPER_ADMIN', 'DEVELOPER'].includes(dbUser.role)) {
            await interaction.editReply({
              content: `ℹ️ **${targetUser.username}** ist bereits ${dbUser.role}.`,
            });
            return;
          }

          await prisma.user.update({
            where: { discordId: targetUser.id },
            data: { role: 'ADMIN' },
          });
        }

        logAudit('ADMIN_ROLE_ASSIGNED', 'AUTH', {
          userId: interaction.user.id,
          targetUserId: targetUser.id,
          targetUsername: targetUser.username,
        });

        const embed = new EmbedBuilder()
          .setTitle('✅ Admin hinzugefügt')
          .setDescription(`**${targetUser.username}** wurde als Admin eingetragen.`)
          .addFields(
            { name: 'Discord-ID', value: targetUser.id, inline: true },
            { name: 'Rolle', value: 'ADMIN', inline: true },
          )
          .setColor(0x00ff00)
          .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
        break;
      }

      case 'remove': {
        const targetUser = interaction.options.getUser('user', true);

        const dbUser = await prisma.user.findUnique({
          where: { discordId: targetUser.id },
        });

        if (!dbUser || !['ADMIN', 'SUPER_ADMIN'].includes(dbUser.role)) {
          await interaction.editReply({
            content: `❌ **${targetUser.username}** ist kein Admin.`,
          });
          return;
        }

        await prisma.user.update({
          where: { discordId: targetUser.id },
          data: { role: 'USER' },
        });

        logAudit('ADMIN_ROLE_REMOVED', 'AUTH', {
          userId: interaction.user.id,
          targetUserId: targetUser.id,
          targetUsername: targetUser.username,
        });

        const embed = new EmbedBuilder()
          .setTitle('❌ Admin entfernt')
          .setDescription(`**${targetUser.username}** ist kein Admin mehr.`)
          .addFields(
            { name: 'Discord-ID', value: targetUser.id, inline: true },
            { name: 'Neue Rolle', value: 'USER', inline: true },
          )
          .setColor(0xff9900)
          .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
        break;
      }

      case 'list': {
        const admins = await prisma.user.findMany({
          where: {
            role: { in: ['ADMIN', 'SUPER_ADMIN', 'DEVELOPER'] },
          },
          orderBy: { role: 'asc' },
        });

        if (admins.length === 0) {
          await interaction.editReply({
            content: '📋 Keine Admins eingetragen. Verwende `/dev-admin add` um einen hinzuzufügen.',
          });
          return;
        }

        const embed = new EmbedBuilder()
          .setTitle('📋 Admin-Liste')
          .setDescription(`**${admins.length} Admin(s) eingetragen:**`)
          .setColor(0x0099ff)
          .setTimestamp();

        for (const admin of admins) {
          const roleEmoji = admin.role === 'DEVELOPER' ? '👨‍💻' : admin.role === 'SUPER_ADMIN' ? '🛡️' : '⚙️';
          embed.addFields({
            name: `${roleEmoji} ${admin.username}`,
            value: `ID: \`${admin.discordId}\` | Rolle: **${admin.role}** | Seit: ${admin.createdAt.toLocaleDateString('de-DE')}`,
            inline: false,
          });
        }

        await interaction.editReply({ embeds: [embed] });
        break;
      }
    }
  },
};

export default devAdminCommand;
