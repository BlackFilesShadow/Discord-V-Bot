import type { Client, Message } from 'discord.js';
import prisma from '../../database/prisma';
import { logger } from '../../utils/logger';
import {
  prepareTicketUploadAttachments,
  preparedTicketRelayFiles,
  verifyTicketRelayAttachments,
} from './ticketAttachmentRelay';
import {
  DASHBOARD_TICKET_REPLY_MAX_CHARS,
  encodeTicketMessageContent,
  type StoredTicketAttachment,
} from './ticketMessageEnvelope';
import { publishTicketRealtimeEvent } from './ticketRealtime';

export interface DashboardTicketUpload {
  name: string;
  contentType: string | null;
  size: number;
  bytes: Buffer;
}

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

function splitRemainder(text: string, firstCapacity: number): string[] {
  if (text.length <= firstCapacity) return [];
  const chunks: string[] = [];
  let offset = firstCapacity;
  while (offset < text.length) {
    chunks.push(text.slice(offset, offset + 2000));
    offset += 2000;
  }
  return chunks;
}

export async function replyToOwnerTicketFromDashboard(input: {
  ticketId: string;
  ownerDiscordId: string;
  content: string;
  attachments?: readonly DashboardTicketUpload[];
  client: Client;
}): Promise<DashboardTicketReplyResult> {
  const content = input.content.trim();
  const uploads = input.attachments ?? [];
  if ((content.length < 1 && uploads.length === 0) || content.length > DASHBOARD_TICKET_REPLY_MAX_CHARS) {
    throw new Error(`Ticket-Antwort muss mindestens Text oder einen Anhang enthalten und darf maximal ${DASHBOARD_TICKET_REPLY_MAX_CHARS} Zeichen lang sein.`);
  }

  const preparedAttachments = prepareTicketUploadAttachments(uploads.map(file => ({
    name: file.name,
    bytes: file.bytes,
    size: file.size,
  })));
  const storedAttachments: StoredTicketAttachment[] = uploads.map(file => ({
    name: file.name,
    size: file.size,
    contentType: file.contentType,
  }));

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

  const history = await prisma.ticketMessage.create({
    data: {
      ticketId: ticket.id,
      fromDiscordId: input.ownerDiscordId,
      fromRole: 'OWNER',
      content: encodeTicketMessageContent(content, storedAttachments),
    },
  });
  // Nach der Owner-Pruefung ist die eindeutige Ticket-ID bereits autorisiert;
  // ein kuenstlicher guildId-Filter wuerde globale/null-Guild-Tickets brechen.
  // eslint-disable-next-line local/no-unscoped-prisma-query -- Autorisierte globale Ticket-ID nach expliziter ownerDiscordId-Pruefung.
  await prisma.ticket.update({
    where: { id: ticket.id },
    data: { updatedAt: new Date() },
  });
  publishTicketRealtimeEvent(ticket.id, 'message');

  const sentMessages: Message[] = [];
  try {
    const target = await input.client.users.fetch(ticket.userDiscordId);
    const header = `**🛡️ Owner** · Ticket #${ticket.ticketNumber}`;
    const files = preparedTicketRelayFiles(preparedAttachments);
    const firstCapacity = Math.max(1, 2000 - header.length - 1);
    const firstText = content.slice(0, firstCapacity);
    const firstContent = firstText.length > 0 ? `${header}\n${firstText}` : header;

    sentMessages.push(await target.send({
      content: firstContent,
      ...(files.length > 0 ? { files } : {}),
      allowedMentions: { parse: [] },
    }));

    for (const chunk of splitRemainder(content, firstCapacity)) {
      sentMessages.push(await target.send({
        content: chunk,
        allowedMentions: { parse: [] },
      }));
    }

    if (preparedAttachments.length > 0) {
      const attachmentMessage = sentMessages[0];
      await verifyTicketRelayAttachments(attachmentMessage.attachments.values(), preparedAttachments);
      await prisma.ticketMessage.update({
        where: { id: history.id },
        data: {
          content: encodeTicketMessageContent(content, storedAttachments, {
            channelId: attachmentMessage.channelId,
            messageId: attachmentMessage.id,
          }),
        },
      });
      publishTicketRealtimeEvent(ticket.id, 'message');
    }
  } catch (error) {
    for (const sent of [...sentMessages].reverse()) {
      try { await sent.delete(); } catch { /* best effort: keine partielle Dashboard-Antwort liegen lassen */ }
    }
    logger.warn(`Ticket #${ticket.ticketNumber}: Dashboard-Relay-DM an ${ticket.userDiscordId} fehlgeschlagen`, {
      error: String(error),
    });
    return {
      ok: false,
      code: 'DELIVERY_FAILED',
      message: 'Antwort wurde im Ticket gespeichert, konnte aber nicht vollstaendig per DM zugestellt werden.',
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
