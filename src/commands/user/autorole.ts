import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  MessageFlags,
  inlineCode,
  roleMention,
} from 'discord.js';
import { AutoRoleTrigger } from '@prisma/client';
import { Command } from '../../types';
import prisma from '../../database/prisma';
import { Colors, Brand, vEmbed } from '../../utils/embedDesign';
import { logAudit } from '../../utils/logger';

/**
 * /autorole (Sektion 9):
 * Automatische Rollenvergabe pro Guild.
 *
 * Multi-Guild: Alle Operationen sind STRIKT auf interaction.guildId beschraenkt.
 * Eine in Guild A erstellte Auto-Rolle ist in Guild B nicht sichtbar/aenderbar.
 */

const TRIGGER_CHOICES = [
  { name: 'Beitritt', value: 'JOIN' },
  { name: 'Reaktion', value: 'REACTION' },
  { name: 'Level', value: 'LEVEL' },
  { name: 'Aktivität', value: 'ACTIVITY' },
  { name: 'Event', value: 'EVENT' },
  { name: 'Giveaway', value: 'GIVEAWAY' },
] as const;

function parseTrigger(v: string): AutoRoleTrigger | null {
  const allowed: AutoRoleTrigger[] = ['JOIN', 'REACTION', 'LEVEL', 'ACTIVITY', 'EVENT', 'GIVEAWAY', 'CUSTOM'];
  return (allowed as string[]).includes(v) ? (v as AutoRoleTrigger) : null;
}

const autoroleCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('autorole')
    .setDescription('Automatische Rollenvergabe verwalten')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .setDMPermission(false)
    .addSubcommand(sub =>
      sub
        .setName('erstellen')
        .setDescription('Neue Auto-Rolle erstellen')
        .addRoleOption(opt => opt.setName('rolle').setDescription('Zu vergebende Rolle').setRequired(true))
        .addStringOption(opt =>
          opt.setName('trigger').setDescription('Auslöser').setRequired(true).addChoices(...TRIGGER_CHOICES)
        )
        .addStringOption(opt =>
          opt.setName('wert').setDescription('Trigger-Wert (z. B. Emoji, Level, Event-Name)').setRequired(false).setMaxLength(120)
        )
        .addChannelOption(opt => opt.setName('channel').setDescription('Channel (für Reaction-Roles)').setRequired(false))
        .addStringOption(opt =>
          opt.setName('nachricht-id').setDescription('Nachricht-ID (für Reaction-Roles)').setRequired(false).setMaxLength(40)
        )
        .addIntegerOption(opt =>
          opt.setName('dauer-stunden').setDescription('Zeitlimitiert (Stunden, 0 = permanent)').setRequired(false).setMinValue(0).setMaxValue(8760)
        )
    )
    .addSubcommand(sub => sub.setName('liste').setDescription('Alle Auto-Rollen dieses Servers anzeigen'))
    .addSubcommand(sub => sub.setName('loeschen').setDescription('Auto-Rolle entfernen')
      .addStringOption(opt => opt.setName('id').setDescription('Auto-Rolle ID').setRequired(true)))
    .addSubcommand(sub => sub.setName('toggle').setDescription('Auto-Rolle aktivieren/deaktivieren')
      .addStringOption(opt => opt.setName('id').setDescription('Auto-Rolle ID').setRequired(true)))
    .addSubcommand(sub => sub.setName('blacklist').setDescription('Rolle zur Blacklist hinzufügen')
      .addStringOption(opt => opt.setName('autorole-id').setDescription('Auto-Rolle ID').setRequired(true))
      .addRoleOption(opt => opt.setName('rolle').setDescription('Zu blockierende Rolle').setRequired(true)))
    .addSubcommand(sub => sub.setName('whitelist').setDescription('Rolle zur Whitelist hinzufügen')
      .addStringOption(opt => opt.setName('autorole-id').setDescription('Auto-Rolle ID').setRequired(true))
      .addRoleOption(opt => opt.setName('rolle').setDescription('Erlaubte Rolle').setRequired(true))) as SlashCommandBuilder,

  execute: async (interaction: ChatInputCommandInteraction) => {
    if (!interaction.guildId) {
      await interaction.reply({ content: '❌ Nur in Servern verfügbar.', flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const guildId = interaction.guildId;
    const sub = interaction.options.getSubcommand();

    switch (sub) {
      case 'erstellen': {
        const role = interaction.options.getRole('rolle', true);
        const trigger = parseTrigger(interaction.options.getString('trigger', true));
        if (!trigger) {
          await interaction.editReply({ content: '❌ Unbekannter Trigger.' });
          return;
        }
        const triggerValue = interaction.options.getString('wert');
        const channel = interaction.options.getChannel('channel');
        const messageId = interaction.options.getString('nachricht-id');
        const durationHours = interaction.options.getInteger('dauer-stunden') ?? 0;
        const expiresAt = durationHours > 0 ? new Date(Date.now() + durationHours * 3600_000) : null;

        const autoRole = await prisma.autoRole.create({
          data: {
            guildId,
            roleId: role.id,
            roleName: role.name,
            triggerType: trigger,
            triggerValue,
            channelId: channel?.id,
            messageId,
            expiresAt,
          },
        });

        logAudit('AUTOROLE_CREATED', 'ROLE', {
          autoRoleId: autoRole.id, guildId, roleId: role.id, trigger, adminId: interaction.user.id,
        });

        await interaction.editReply({
          embeds: [
            vEmbed(Colors.Success)
              .setTitle('✅ Auto-Rolle erstellt')
              .addFields(
                { name: 'Rolle', value: roleMention(role.id), inline: true },
                { name: 'Trigger', value: trigger, inline: true },
                { name: 'Wert', value: triggerValue ?? 'N/A', inline: true },
                { name: 'ID', value: inlineCode(autoRole.id), inline: false },
                { name: 'Zeitlimit', value: expiresAt ? `${durationHours}h` : 'Permanent', inline: true },
              )
              .setFooter({ text: Brand.footerText }),
          ],
        });
        return;
      }

      case 'liste': {
        const autoRoles = await prisma.autoRole.findMany({
          where: { guildId },
          orderBy: { createdAt: 'desc' },
        });
        if (autoRoles.length === 0) {
          await interaction.editReply({ content: '📋 Keine Auto-Rollen für diesen Server konfiguriert.' });
          return;
        }
        const lines = autoRoles.map((ar, i) => {
          const status = ar.isActive ? '🟢' : '🔴';
          const expiry = ar.expiresAt ? `⏰ ${ar.expiresAt.toLocaleDateString('de-DE')}` : '∞';
          return `${status} **${i + 1}.** ${roleMention(ar.roleId)} — **${ar.triggerType}**${ar.triggerValue ? ` (${ar.triggerValue})` : ''}\n` +
            `   ID: ${inlineCode(ar.id)}\n` +
            `   Status: ${expiry}`;
        });
        await interaction.editReply({
          embeds: [
            vEmbed(Colors.Info)
              .setTitle('📋 Auto-Rollen')
              .setDescription(lines.join('\n\n'))
              .setFooter({ text: `${autoRoles.length} Auto-Rollen ${Brand.dot} ${Brand.footerText}` }),
          ],
        });
        return;
      }

      case 'loeschen': {
        const id = interaction.options.getString('id', true);
        const existing = await prisma.autoRole.findFirst({ where: { id, guildId } });
        if (!existing) {
          await interaction.editReply({ content: '❌ Auto-Rolle nicht gefunden (oder gehört zu einem anderen Server).' });
          return;
        }
        await prisma.autoRole.delete({ where: { id } });
        logAudit('AUTOROLE_DELETED', 'ROLE', { autoRoleId: id, guildId, adminId: interaction.user.id });
        await interaction.editReply({ content: `🗑️ Auto-Rolle für ${roleMention(existing.roleId)} gelöscht.` });
        return;
      }

      case 'toggle': {
        const id = interaction.options.getString('id', true);
        const existing = await prisma.autoRole.findFirst({ where: { id, guildId } });
        if (!existing) {
          await interaction.editReply({ content: '❌ Auto-Rolle nicht gefunden.' });
          return;
        }
        const newState = !existing.isActive;
        await prisma.autoRole.update({ where: { id }, data: { isActive: newState } });
        logAudit('AUTOROLE_TOGGLED', 'ROLE', { autoRoleId: id, guildId, isActive: newState, adminId: interaction.user.id });
        await interaction.editReply({ content: `${newState ? '✅ Aktiviert' : '🔴 Deaktiviert'}: Auto-Rolle ${roleMention(existing.roleId)}` });
        return;
      }

      case 'blacklist':
      case 'whitelist': {
        const isBlacklist = sub === 'blacklist';
        const autoroleId = interaction.options.getString('autorole-id', true);
        const role = interaction.options.getRole('rolle', true);
        const existing = await prisma.autoRole.findFirst({ where: { id: autoroleId, guildId } });
        if (!existing) {
          await interaction.editReply({ content: '❌ Auto-Rolle nicht gefunden.' });
          return;
        }
        const fieldKey = isBlacklist ? 'blacklistRoles' : 'whitelistRoles';
        const current = ((existing as Record<string, unknown>)[fieldKey] as string[] | null) ?? [];
        if (!current.includes(role.id)) current.push(role.id);
        await prisma.autoRole.update({
          where: { id: autoroleId },
          data: { [fieldKey]: current },
        });
        logAudit(isBlacklist ? 'AUTOROLE_BLACKLIST_ADD' : 'AUTOROLE_WHITELIST_ADD', 'ROLE', {
          autoRoleId: autoroleId, guildId, roleId: role.id, adminId: interaction.user.id,
        });
        await interaction.editReply({
          content: `${isBlacklist ? '🚫' : '✅'} ${roleMention(role.id)} zur ${isBlacklist ? 'Blacklist' : 'Whitelist'} hinzugefügt.`,
        });
        return;
      }
    }
  },
};

export default autoroleCommand;
