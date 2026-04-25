import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
} from 'discord.js';
import { Command } from '../../types';
import { Colors, vEmbed } from '../../utils/embedDesign';
import { closeTicket } from '../../modules/ticket/ticketManager';
import { config } from '../../config';
import prisma from '../../database/prisma';

/**
 * /admin-tickets - Owner/Admin-Werkzeug fuer Tickets.
 *
 * Subcommands:
 *  - list:  Alle offenen Tickets auflisten.
 *  - close: Ein bestimmtes Ticket per #Nummer schliessen (Owner-Rechte vorausgesetzt).
 *
 * Abgrenzung zu /ticket close:
 *  - /ticket close: schliesst NUR das eigene Ticket des Aufrufers.
 *  - /admin-tickets close: Owner/Admin kann jedes Ticket schliessen, in dem er Empfaenger ist
 *    (oder als Bot-Owner generell).
 */
async function isAdminOrOwner(discordId: string): Promise<boolean> {
  if (config.discord.ownerId && config.discord.ownerId === discordId) return true;
  const u = await prisma.user.findUnique({ where: { discordId }, select: { role: true } });
  if (!u) return false;
  return ['ADMIN', 'SUPER_ADMIN', 'DEVELOPER'].includes(u.role);
}

const adminTicketsCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('admin-tickets')
    .setDescription('Owner/Admin: Tickets verwalten und schliessen')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(sub =>
      sub.setName('list').setDescription('Offene Tickets auflisten')
    )
    .addSubcommand(sub =>
      sub.setName('close')
        .setDescription('Ein Ticket per Nummer schliessen')
        .addIntegerOption(o =>
          o.setName('nummer').setDescription('Ticket-Nummer (z.B. 7)').setRequired(true).setMinValue(1)
        )
        .addStringOption(o =>
          o.setName('grund').setDescription('Optionaler Grund/Notiz').setRequired(false).setMaxLength(300)
        )
    ) as SlashCommandBuilder,

  adminOnly: true,

  execute: async (interaction: ChatInputCommandInteraction) => {
    await interaction.deferReply({ ephemeral: true });

    if (!(await isAdminOrOwner(interaction.user.id))) {
      await interaction.editReply({
        embeds: [vEmbed(Colors.Error).setTitle('❌  Keine Berechtigung').setDescription('Nur Owner oder Admin.')],
      });
      return;
    }

    const sub = interaction.options.getSubcommand();

    if (sub === 'list') {
      const open = await prisma.ticket.findMany({
        where: { status: { in: ['PENDING', 'OPEN'] } },
        orderBy: { createdAt: 'asc' },
        take: 25,
      });
      if (open.length === 0) {
        await interaction.editReply({
          embeds: [vEmbed(Colors.Info).setTitle('🎟️  Keine offenen Tickets').setDescription('Aktuell ist nichts offen.')],
        });
        return;
      }
      const lines = open.map(t =>
        `**#${t.ticketNumber}** · \`${t.status}\` · <@${t.userDiscordId}> · ${t.subject.slice(0, 60)} · ${t.createdAt.toLocaleString('de-DE')}`,
      );
      await interaction.editReply({
        embeds: [
          vEmbed(Colors.Info)
            .setTitle(`🎟️  Offene Tickets (${open.length})`)
            .setDescription(lines.join('\n')),
        ],
      });
      return;
    }

    if (sub === 'close') {
      const number = interaction.options.getInteger('nummer', true);
      const reason = interaction.options.getString('grund') ?? null;

      const ticket = await prisma.ticket.findUnique({ where: { ticketNumber: number } });
      if (!ticket) {
        await interaction.editReply({
          embeds: [vEmbed(Colors.Error).setTitle('❌  Nicht gefunden').setDescription(`Ticket #${number} existiert nicht.`)],
        });
        return;
      }

      // Bot-Owner darf jedes Ticket schliessen. Andere Admins nur, wenn sie Empfaenger sind.
      const isBotOwner = config.discord.ownerId && config.discord.ownerId === interaction.user.id;
      const closerId = isBotOwner ? ticket.ownerDiscordId : interaction.user.id;

      const result = await closeTicket(ticket.id, closerId, interaction.client);

      if (result.success && reason) {
        // Grund als Notiz an den User schicken
        try {
          const u = await interaction.client.users.fetch(ticket.userDiscordId);
          await u.send({
            embeds: [
              vEmbed(Colors.Info)
                .setTitle(`📝  Hinweis zu Ticket #${ticket.ticketNumber}`)
                .setDescription(reason),
            ],
          });
        } catch { /* ignore */ }
      }

      await interaction.editReply({
        embeds: [
          vEmbed(result.success ? Colors.Success : Colors.Error)
            .setTitle(result.success ? '🔒  Geschlossen' : '❌  Fehler')
            .setDescription(`${result.message}${reason ? `\nGrund: ${reason}` : ''}`),
        ],
      });
    }
  },
};

export default adminTicketsCommand;
