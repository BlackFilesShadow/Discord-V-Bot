import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
} from 'discord.js';
import { Command } from '../../types';
import prisma from '../../database/prisma';
import { logAudit, logger } from '../../utils/logger';
import { safeDm } from '../../utils/safeSend';

/**
 * /admin-broadcast [msg] — Nachricht an alle Nutzer/Hersteller.
 * Developer-Bereich: PN-Kommunikation.
 */
const adminBroadcastCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('admin-broadcast')
    .setDescription('Broadcast-Nachricht an alle Nutzer oder Hersteller')
    .addStringOption(opt =>
      opt.setName('nachricht').setDescription('Die Broadcast-Nachricht').setRequired(true)
    )
    .addStringOption(opt =>
      opt
        .setName('zielgruppe')
        .setDescription('An wen soll die Nachricht gehen?')
        .setRequired(false)
        .addChoices(
          { name: 'Alle', value: 'ALL' },
          { name: 'Hersteller', value: 'MANUFACTURER' },
          { name: 'Admins', value: 'ADMIN' },
          { name: 'Moderatoren', value: 'MODERATOR' },
        )
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator) as SlashCommandBuilder,
  adminOnly: true,

  execute: async (interaction: ChatInputCommandInteraction) => {
    await interaction.deferReply({ ephemeral: true });

    const message = interaction.options.getString('nachricht', true);
    const target = interaction.options.getString('zielgruppe') || 'ALL';

    const where: Record<string, unknown> = { status: 'ACTIVE' };
    if (target === 'MANUFACTURER') {
      where.isManufacturer = true;
    } else if (target !== 'ALL') {
      where.role = target;
    }

    const users = await prisma.user.findMany({ where, select: { discordId: true } });

    // Truncation auf Discord-Limit (2000 – Header).
    const safeMessage = message.slice(0, 1900);
    const payload = `📢 **Broadcast-Nachricht:**\n\n${safeMessage}`;

    let sent = 0;
    let failed = 0;

    for (const user of users) {
      try {
        const discordUser = await interaction.client.users.fetch(user.discordId);
        // safeDm erzwingt allowedMentions: { parse: [] } – keine @everyone-Injection.
        const result = await safeDm(discordUser, payload);
        if (result) sent++; else failed++;
      } catch (e) {
        logger.debug(`Broadcast: User ${user.discordId} unerreichbar: ${String(e)}`);
        failed++;
      }
    }

    logAudit('BROADCAST_SENT', 'ADMIN', {
      adminId: interaction.user.id,
      target,
      totalUsers: users.length,
      sent,
      failed,
    });

    await interaction.editReply({
      content: `📢 Broadcast gesendet!\n• Zielgruppe: ${target}\n• Erfolgreich: ${sent}\n• Fehlgeschlagen: ${failed}\n• Gesamt: ${users.length}`,
    });
  },
};

export default adminBroadcastCommand;
