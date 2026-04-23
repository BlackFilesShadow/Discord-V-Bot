import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
} from 'discord.js';
import { Command } from '../../types';
import { Colors, vEmbed } from '../../utils/embedDesign';
import { createTicket, closeTicket } from '../../modules/ticket/ticketManager';
import prisma from '../../database/prisma';

/**
 * /ticket - Hochmodernes Ticket-System: Anfrage an Bot-Owner via DM-Bridge.
 *
 * Subcommands:
 *  - open:   Neue Anfrage stellen (subject + nachricht). Owner bekommt DM mit Buttons.
 *  - close:  Aktives Ticket schliessen (User oder Owner).
 *  - status: Eigene Tickets anzeigen.
 */
const ticketCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('ticket')
    .setDescription('Owner-Kontakt: Anfrage stellen, Chat fuehren, schliessen')
    .addSubcommand(sub =>
      sub.setName('open')
        .setDescription('Neue Anfrage an den Owner stellen')
        .addStringOption(o => o.setName('betreff').setDescription('Worum geht es?').setRequired(true).setMaxLength(150))
        .addStringOption(o => o.setName('nachricht').setDescription('Deine Anfrage im Detail').setRequired(true).setMaxLength(1500))
    )
    .addSubcommand(sub =>
      sub.setName('close').setDescription('Dein aktives Ticket schliessen')
    )
    .addSubcommand(sub =>
      sub.setName('status').setDescription('Status deiner letzten Tickets anzeigen')
    ) as SlashCommandBuilder,

  execute: async (interaction: ChatInputCommandInteraction) => {
    const sub = interaction.options.getSubcommand();
    await interaction.deferReply({ ephemeral: true });

    if (sub === 'open') {
      const subject = interaction.options.getString('betreff', true);
      const message = interaction.options.getString('nachricht', true);
      const result = await createTicket({
        client: interaction.client,
        userDiscordId: interaction.user.id,
        username: interaction.user.username,
        guildId: interaction.guildId,
        guildName: interaction.guild?.name ?? null,
        subject,
        initialMessage: message,
      });
      await interaction.editReply({
        embeds: [
          vEmbed(result.success ? Colors.Success : Colors.Error)
            .setTitle(result.success ? `📨  Ticket #${result.ticketNumber} erstellt` : '❌  Fehler')
            .setDescription(result.message),
        ],
      });
      return;
    }

    if (sub === 'close') {
      const ticket = await prisma.ticket.findFirst({
        where: { userDiscordId: interaction.user.id, status: { in: ['PENDING', 'OPEN'] } },
        orderBy: { createdAt: 'desc' },
      });
      if (!ticket) {
        await interaction.editReply({ content: 'Du hast kein offenes Ticket.' });
        return;
      }
      const result = await closeTicket(ticket.id, interaction.user.id, interaction.client);
      await interaction.editReply({
        embeds: [
          vEmbed(result.success ? Colors.Success : Colors.Error)
            .setTitle(result.success ? '🔒  Geschlossen' : '❌  Fehler')
            .setDescription(result.message),
        ],
      });
      return;
    }

    if (sub === 'status') {
      const tickets = await prisma.ticket.findMany({
        where: { userDiscordId: interaction.user.id },
        orderBy: { createdAt: 'desc' },
        take: 10,
      });
      if (tickets.length === 0) {
        await interaction.editReply({ content: 'Du hast noch keine Tickets erstellt.' });
        return;
      }
      const lines = tickets.map(t =>
        `**#${t.ticketNumber}** · \`${t.status}\` · ${t.subject.slice(0, 60)} · ${t.createdAt.toLocaleString('de-DE')}`,
      );
      await interaction.editReply({
        embeds: [
          vEmbed(Colors.Info)
            .setTitle('🎟️  Deine Tickets')
            .setDescription(lines.join('\n')),
        ],
      });
    }
  },
};

export default ticketCommand;
