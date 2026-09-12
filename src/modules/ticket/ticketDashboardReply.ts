import type { Client } from 'discord.js';
import prisma from '../../database/prisma';
import { logger } from '../../utils/logger';

export type DashboardTicketReplyResult =
  | {
      ok: true;
      ticketNumber: number;
      userDiscordId: string;
      recorded: true;
      delivered: true;
    }
  | {
      ok: false;
      code: 'NOT_FOUND' | 'NOT_OWNER' | 'NOT_OPEN' | 'DELIVERY_FAILED';
      message: string;
      ticketNumber?: number;
      userDiscordId?: string;
      recorded: boolean;
      delivered: false;
    };

export async function replyToOwnerTicketFromDashboard(input: {
  ticketId: string;
  ownerDiscordId: string;
  content: string;
  client: Client;
}): Promise<DashboardTicketReplyResult> {
  const content = input.content.trim();
  if (content.length < 1 || content.length > 1800) {
    throw new Error('Ticket-Antwort muss zwischen 1 und 1800 Zeichen lang sein.');
  }

  // Bot-Owner-Tickets sind bewusst global: `guildId` ist nur optionale
  // Herkunftsmetadaten. Die Autorisierungsgrenze wird direkt danach ueber die
  // kanonische `ownerDiscordId` erzwungen, damit auch Legacy-/DM-Tickets ohne
  // Guild-Zuordnung sicher erreichbar bleiben.
  // eslint-disable-next-line local/no-unscoped-prisma-query -- Globaler Bot-Owner-Ticket-Bridge; ownerDiscordId ist der Autorisierungsscope, guildId ist optional.
  const ticket = await prisma.ticket.findUnique({
    where: { id: input.ticketId },
    select: {
      id: true,
      ticketNumber: true,
      userDiscordId: true,
      ownerDiscordId: true,
      status: true,
    },
  });

  if (!ticket) {
    return {
      ok: false,
      code: 'NOT_FOUND',
      message: 'Ticket nicht gefunden.',
      recorded: false,
      delivered: false,
    };
  }

  if (ticket.ownerDiscordId !== input.ownerDiscordId) {
    return {
      ok: false,
      code: 'NOT_OWNER',
      message: 'Dieses Ticket gehoert nicht zur aktuellen Owner-Identitaet.',
      ticketNumber: ticket.ticketNumber,
      userDiscordId: ticket.userDiscordId,
      recorded: false,
      delivered: false,
    };
  }

  if (ticket.status !== 'OPEN') {
    return {
      ok: false,
      code: 'NOT_OPEN',
      message: `Ticket #${ticket.ticketNumber} ist nicht offen (${ticket.status}).`,
      ticketNumber: ticket.ticketNumber,
      userDiscordId: ticket.userDiscordId,
      recorded: false,
      delivered: false,
    };
  }

  await prisma.ticketMessage.create({
    data: {
      ticketId: ticket.id,
      fromDiscordId: input.ownerDiscordId,
      fromRole: 'OWNER',
      content,
    },
  });
  // Nach der Owner-Pruefung ist die eindeutige Ticket-ID bereits autorisiert;
  // ein kuenstlicher guildId-Filter wuerde globale/null-Guild-Tickets brechen.
  // eslint-disable-next-line local/no-unscoped-prisma-query -- Autorisierte globale Ticket-ID nach expliziter ownerDiscordId-Pruefung.
  await prisma.ticket.update({
    where: { id: ticket.id },
    data: { updatedAt: new Date() },
  });

  try {
    const target = await input.client.users.fetch(ticket.userDiscordId);
    await target.send({
      content: `**🛡️ Owner** · Ticket #${ticket.ticketNumber}\n${content}`,
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    logger.warn(`Ticket #${ticket.ticketNumber}: Dashboard-Relay-DM an ${ticket.userDiscordId} fehlgeschlagen`, {
      error: String(error),
    });
    return {
      ok: false,
      code: 'DELIVERY_FAILED',
      message: 'Antwort wurde im Ticket gespeichert, konnte aber nicht per DM zugestellt werden.',
      ticketNumber: ticket.ticketNumber,
      userDiscordId: ticket.userDiscordId,
      recorded: true,
      delivered: false,
    };
  }

  return {
    ok: true,
    ticketNumber: ticket.ticketNumber,
    userDiscordId: ticket.userDiscordId,
    recorded: true,
    delivered: true,
  };
}
