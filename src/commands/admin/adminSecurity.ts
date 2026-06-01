import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
  MessageFlags,
} from 'discord.js';
import { isIP } from 'net';
import { Prisma } from '@prisma/client';
import { Command } from '../../types';
import prisma from '../../database/prisma';
import { logAudit } from '../../utils/logger';

/**
 * /admin-security — Security-Events, Blacklist/Whitelist, IP-Analyse.
 * Sektion 4: Schutz vor Missbrauch, IP- und Verhaltensanalyse, Blacklist/Whitelist.
 */
const adminSecurityCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('admin-security')
    .setDescription('Security-Events und IP-Management')
    .addSubcommand(sub =>
      sub
        .setName('events')
        .setDescription('Security-Events anzeigen')
        .addStringOption(opt =>
          opt
            .setName('typ')
            .setDescription('Event-Typ')
            .setRequired(false)
            .addChoices(
              { name: 'Alle', value: 'ALL' },
              { name: 'Login-Fehler', value: 'LOGIN_FAILURE' },
              { name: 'Brute-Force', value: 'BRUTE_FORCE' },
              { name: 'Rate-Limit', value: 'RATE_LIMIT_EXCEEDED' },
              { name: 'Verdächtig', value: 'SUSPICIOUS_ACTIVITY' },
              { name: 'Raid', value: 'RAID_DETECTED' },
              { name: 'Spam', value: 'SPAM_DETECTED' },
              { name: 'Malware', value: 'MALWARE_DETECTED' },
            )
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('blacklist')
        .setDescription('IP zur Blacklist hinzufügen')
        .addStringOption(opt =>
          opt.setName('ip').setDescription('IP-Adresse').setRequired(true)
        )
        .addStringOption(opt =>
          opt.setName('grund').setDescription('Begründung').setRequired(true)
        )
        .addIntegerOption(opt =>
          opt.setName('dauer-stunden').setDescription('Dauer in Stunden (0 = permanent)').setRequired(false).setMinValue(0).setMaxValue(8760)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('whitelist')
        .setDescription('IP zur Whitelist hinzufügen')
        .addStringOption(opt =>
          opt.setName('ip').setDescription('IP-Adresse').setRequired(true)
        )
        .addStringOption(opt =>
          opt.setName('grund').setDescription('Begründung').setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('ip-entfernen')
        .setDescription('IP von Black-/Whitelist entfernen')
        .addStringOption(opt =>
          opt.setName('ip').setDescription('IP-Adresse').setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('resolve')
        .setDescription('Security-Event als gelöst markieren')
        .addStringOption(opt =>
          opt.setName('event-id').setDescription('Event-ID').setRequired(true)
        )
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator) as SlashCommandBuilder,
  // Security-Events, IP-Blacklist/Whitelist sind global (kein guildId in den
  // Modellen SecurityEvent/IpList) und sicherheitskritisch. Daher Owner/Dev-only
  // (Passwort-Gate) statt jeder Admin-Rolle, um guild-uebergreifende Manipulation
  // (z.B. globales IP-Blacklisting durch einen einzelnen Guild-Admin) zu verhindern.
  devOnly: true,

  execute: async (interaction: ChatInputCommandInteraction) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const sub = interaction.options.getSubcommand();

    switch (sub) {
      case 'events': {
        const type = interaction.options.getString('typ') || 'ALL';
        const where: Prisma.SecurityEventWhereInput = {};
        if (type !== 'ALL') {
          where.eventType = type as Prisma.SecurityEventWhereInput['eventType'];
        }

        const events = await prisma.securityEvent.findMany({
          where,
          take: 15,
          orderBy: { createdAt: 'desc' },
          include: { user: true },
        });

        if (events.length === 0) {
          await interaction.editReply({ content: '✅ Keine Security-Events gefunden.' });
          return;
        }

        const lines = events.map((e) => {
          const emoji: string = ({ CRITICAL: '🔴', HIGH: '🟠', MEDIUM: '🟡', LOW: '🔵' } as Record<string, string>)[e.severity] || '⚪';
          const resolved = e.isResolved ? '✅' : '⏳';
          const time = e.createdAt.toLocaleString('de-DE');
          return `${emoji} ${resolved} \`${time}\`\n` +
            `   **${e.eventType}** [${e.severity}]\n` +
            `   ${e.description}\n` +
            `   ${e.ipAddress ? `IP: \`${e.ipAddress}\`` : ''}${e.user ? ` User: <@${e.user.discordId}>` : ''}\n` +
            `   ID: \`${e.id}\``;
        });

        const embed = new EmbedBuilder()
          .setTitle('🔒 Security-Events')
          .setDescription(lines.join('\n\n'))
          .setColor(0xe74c3c)
          .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
        break;
      }

      case 'blacklist': {
        const ip = interaction.options.getString('ip', true).trim();
        const reason = interaction.options.getString('grund', true);
        const hours = interaction.options.getInteger('dauer-stunden') || 0;

        if (isIP(ip) === 0) {
          await interaction.editReply({ content: '❌ Ungültige IP-Adresse (IPv4 oder IPv6 erwartet).' });
          return;
        }

        const expiresAt = hours > 0 ? new Date(Date.now() + hours * 60 * 60 * 1000) : null;

        await prisma.ipList.upsert({
          where: { ipAddress: ip },
          create: { ipAddress: ip, listType: 'BLACKLIST', reason, addedBy: interaction.user.id, expiresAt },
          update: { listType: 'BLACKLIST', reason, addedBy: interaction.user.id, expiresAt },
        });

        logAudit('IP_BLACKLISTED', 'SECURITY', { ip, reason, hours, adminId: interaction.user.id });
        await interaction.editReply({ content: `🚫 IP \`${ip}\` zur Blacklist hinzugefügt.${hours > 0 ? ` (${hours}h)` : ' (permanent)'}` });
        break;
      }

      case 'whitelist': {
        const ip = interaction.options.getString('ip', true).trim();
        const reason = interaction.options.getString('grund', true);

        if (isIP(ip) === 0) {
          await interaction.editReply({ content: '❌ Ungültige IP-Adresse (IPv4 oder IPv6 erwartet).' });
          return;
        }

        await prisma.ipList.upsert({
          where: { ipAddress: ip },
          create: { ipAddress: ip, listType: 'WHITELIST', reason, addedBy: interaction.user.id },
          update: { listType: 'WHITELIST', reason, addedBy: interaction.user.id },
        });

        logAudit('IP_WHITELISTED', 'SECURITY', { ip, reason, adminId: interaction.user.id });
        await interaction.editReply({ content: `✅ IP \`${ip}\` zur Whitelist hinzugefügt.` });
        break;
      }

      case 'ip-entfernen': {
        const ip = interaction.options.getString('ip', true).trim();
        if (isIP(ip) === 0) {
          await interaction.editReply({ content: '❌ Ungültige IP-Adresse.' });
          return;
        }
        const existing = await prisma.ipList.findUnique({ where: { ipAddress: ip } });
        if (!existing) {
          await interaction.editReply({ content: '❌ IP nicht in der Liste.' });
          return;
        }
        await prisma.ipList.delete({ where: { ipAddress: ip } });
        logAudit('IP_REMOVED_FROM_LIST', 'SECURITY', { ip, listType: existing.listType, adminId: interaction.user.id });
        await interaction.editReply({ content: `🗑️ IP \`${ip}\` von der ${existing.listType === 'BLACKLIST' ? 'Blacklist' : 'Whitelist'} entfernt.` });
        break;
      }

      case 'resolve': {
        const eventId = interaction.options.getString('event-id', true);
        const event = await prisma.securityEvent.findUnique({ where: { id: eventId } });
        if (!event) {
          await interaction.editReply({ content: '❌ Security-Event nicht gefunden.' });
          return;
        }
        if (event.isResolved) {
          await interaction.editReply({ content: `ℹ️ Event \`${eventId}\` ist bereits gelöst.` });
          return;
        }

        await prisma.securityEvent.update({
          where: { id: eventId },
          data: { isResolved: true, resolvedBy: interaction.user.id, resolvedAt: new Date() },
        });

        logAudit('SECURITY_EVENT_RESOLVED', 'SECURITY', { eventId, adminId: interaction.user.id });
        await interaction.editReply({ content: `✅ Security-Event \`${eventId}\` als gelöst markiert.` });
        break;
      }
    }
  },
};

export default adminSecurityCommand;
