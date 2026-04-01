import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
} from 'discord.js';
import { Command } from '../../types';
import prisma from '../../database/prisma';
import { logAudit } from '../../utils/logger';

/**
 * /autorole Command (Sektion 9):
 * - Rollen nach Beitritt, Reaktion oder Aktivität automatisch vergeben
 * - Custom-Rollen für bestimmte Events, Level oder Giveaways
 * - Rollen-Management per Command
 * - Mehrfachrollen, Blacklist/Whitelist, Zeitlimitierte Rollen
 */
const autoroleCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('autorole')
    .setDescription('Automatische Rollenvergabe verwalten')
    .addSubcommand(sub =>
      sub
        .setName('erstellen')
        .setDescription('Neue Auto-Rolle erstellen')
        .addRoleOption(opt =>
          opt.setName('rolle').setDescription('Zu vergebende Rolle').setRequired(true)
        )
        .addStringOption(opt =>
          opt
            .setName('trigger')
            .setDescription('Auslöser')
            .setRequired(true)
            .addChoices(
              { name: 'Beitritt', value: 'JOIN' },
              { name: 'Reaktion', value: 'REACTION' },
              { name: 'Level', value: 'LEVEL' },
              { name: 'Aktivität', value: 'ACTIVITY' },
              { name: 'Event', value: 'EVENT' },
              { name: 'Giveaway', value: 'GIVEAWAY' },
            )
        )
        .addStringOption(opt =>
          opt.setName('wert').setDescription('Trigger-Wert (z.B. Emoji, Level-Nummer, Event-Name)').setRequired(false)
        )
        .addChannelOption(opt =>
          opt.setName('channel').setDescription('Channel (für Reaction-Roles)').setRequired(false)
        )
        .addStringOption(opt =>
          opt.setName('nachricht-id').setDescription('Nachricht-ID (für Reaction-Roles)').setRequired(false)
        )
        .addIntegerOption(opt =>
          opt.setName('dauer-stunden').setDescription('Zeitlimitiert (Stunden, 0 = permanent)').setRequired(false)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('liste')
        .setDescription('Alle Auto-Rollen anzeigen')
    )
    .addSubcommand(sub =>
      sub
        .setName('loeschen')
        .setDescription('Auto-Rolle entfernen')
        .addStringOption(opt =>
          opt.setName('id').setDescription('Auto-Rolle ID').setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('toggle')
        .setDescription('Auto-Rolle aktivieren/deaktivieren')
        .addStringOption(opt =>
          opt.setName('id').setDescription('Auto-Rolle ID').setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('blacklist')
        .setDescription('Rolle zur Blacklist einer Auto-Rolle hinzufügen')
        .addStringOption(opt =>
          opt.setName('autorole-id').setDescription('Auto-Rolle ID').setRequired(true)
        )
        .addRoleOption(opt =>
          opt.setName('rolle').setDescription('Zu blockierende Rolle').setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('whitelist')
        .setDescription('Rolle zur Whitelist einer Auto-Rolle hinzufügen')
        .addStringOption(opt =>
          opt.setName('autorole-id').setDescription('Auto-Rolle ID').setRequired(true)
        )
        .addRoleOption(opt =>
          opt.setName('rolle').setDescription('Erlaubte Rolle').setRequired(true)
        )
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles) as SlashCommandBuilder,
  adminOnly: true,

  execute: async (interaction: ChatInputCommandInteraction) => {
    await interaction.deferReply({ ephemeral: true });

    const sub = interaction.options.getSubcommand();

    switch (sub) {
      case 'erstellen': {
        const role = interaction.options.getRole('rolle', true);
        const trigger = interaction.options.getString('trigger', true);
        const triggerValue = interaction.options.getString('wert');
        const channel = interaction.options.getChannel('channel');
        const messageId = interaction.options.getString('nachricht-id');
        const durationHours = interaction.options.getInteger('dauer-stunden') || 0;

        const expiresAt = durationHours > 0 ? new Date(Date.now() + durationHours * 60 * 60 * 1000) : null;

        const autoRole = await prisma.autoRole.create({
          data: {
            roleId: role.id,
            roleName: role.name,
            triggerType: trigger as any,
            triggerValue,
            channelId: channel?.id,
            messageId,
            expiresAt,
          },
        });

        logAudit('AUTOROLE_CREATED', 'ROLE', {
          autoRoleId: autoRole.id, roleId: role.id, trigger, adminId: interaction.user.id,
        });

        const embed = new EmbedBuilder()
          .setTitle('✅ Auto-Rolle erstellt')
          .setColor(0x2ecc71)
          .addFields(
            { name: 'Rolle', value: `<@&${role.id}>`, inline: true },
            { name: 'Trigger', value: trigger, inline: true },
            { name: 'Wert', value: triggerValue || 'N/A', inline: true },
            { name: 'ID', value: `\`${autoRole.id.substring(0, 8)}...\``, inline: true },
            { name: 'Zeitlimit', value: expiresAt ? `${durationHours}h` : 'Permanent', inline: true },
          )
          .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
        break;
      }

      case 'liste': {
        const autoRoles = await prisma.autoRole.findMany({
          orderBy: { createdAt: 'desc' },
        });

        if (autoRoles.length === 0) {
          await interaction.editReply({ content: '📋 Keine Auto-Rollen konfiguriert.' });
          return;
        }

        const lines = autoRoles.map((ar: any, i: number) => {
          const status = ar.isActive ? '🟢' : '🔴';
          const expiry = ar.expiresAt ? `⏰ ${ar.expiresAt.toLocaleDateString('de-DE')}` : '∞';
          return `${status} **${i + 1}.** <@&${ar.roleId}> — **${ar.triggerType}**${ar.triggerValue ? ` (${ar.triggerValue})` : ''}\n` +
            `   ID: \`${ar.id.substring(0, 8)}...\` | ${expiry}`;
        });

        const embed = new EmbedBuilder()
          .setTitle('📋 Auto-Rollen')
          .setDescription(lines.join('\n\n'))
          .setColor(0x3498db)
          .setFooter({ text: `${autoRoles.length} Auto-Rollen konfiguriert` })
          .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
        break;
      }

      case 'loeschen': {
        const id = interaction.options.getString('id', true);
        const existing = await prisma.autoRole.findUnique({ where: { id } });
        if (!existing) {
          await interaction.editReply({ content: '❌ Auto-Rolle nicht gefunden.' });
          return;
        }
        await prisma.autoRole.delete({ where: { id } });
        logAudit('AUTOROLE_DELETED', 'ROLE', { autoRoleId: id, adminId: interaction.user.id });
        await interaction.editReply({ content: `🗑️ Auto-Rolle für <@&${existing.roleId}> gelöscht.` });
        break;
      }

      case 'toggle': {
        const id = interaction.options.getString('id', true);
        const existing = await prisma.autoRole.findUnique({ where: { id } });
        if (!existing) {
          await interaction.editReply({ content: '❌ Auto-Rolle nicht gefunden.' });
          return;
        }

        const newState = !existing.isActive;
        await prisma.autoRole.update({ where: { id }, data: { isActive: newState } });
        logAudit('AUTOROLE_TOGGLED', 'ROLE', { autoRoleId: id, isActive: newState, adminId: interaction.user.id });
        await interaction.editReply({ content: `${newState ? '✅ Aktiviert' : '🔴 Deaktiviert'}: Auto-Rolle <@&${existing.roleId}>` });
        break;
      }

      case 'blacklist': {
        const autoroleId = interaction.options.getString('autorole-id', true);
        const role = interaction.options.getRole('rolle', true);

        const existing = await prisma.autoRole.findUnique({ where: { id: autoroleId } });
        if (!existing) {
          await interaction.editReply({ content: '❌ Auto-Rolle nicht gefunden.' });
          return;
        }

        const currentBlacklist = (existing.blacklistRoles as string[] || []);
        if (!currentBlacklist.includes(role.id)) {
          currentBlacklist.push(role.id);
        }

        await prisma.autoRole.update({
          where: { id: autoroleId },
          data: { blacklistRoles: currentBlacklist },
        });

        await interaction.editReply({ content: `🚫 <@&${role.id}> zur Blacklist der Auto-Rolle hinzugefügt.` });
        break;
      }

      case 'whitelist': {
        const autoroleId = interaction.options.getString('autorole-id', true);
        const role = interaction.options.getRole('rolle', true);

        const existing = await prisma.autoRole.findUnique({ where: { id: autoroleId } });
        if (!existing) {
          await interaction.editReply({ content: '❌ Auto-Rolle nicht gefunden.' });
          return;
        }

        const currentWhitelist = (existing.whitelistRoles as string[] || []);
        if (!currentWhitelist.includes(role.id)) {
          currentWhitelist.push(role.id);
        }

        await prisma.autoRole.update({
          where: { id: autoroleId },
          data: { whitelistRoles: currentWhitelist },
        });

        await interaction.editReply({ content: `✅ <@&${role.id}> zur Whitelist der Auto-Rolle hinzugefügt.` });
        break;
      }
    }
  },
};

export default autoroleCommand;
