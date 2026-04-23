import {
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  EmbedBuilder,
  Client,
  Message,
} from 'discord.js';
import prisma from '../../database/prisma';
import { config } from '../../config';
import { logger, logAudit } from '../../utils/logger';
import { Colors, Brand, vEmbed } from '../../utils/embedDesign';

/**
 * Ticket-System: User -> Owner DM-Bridge.
 *
 * Flow:
 *  1. /ticket open subject:".." nachricht:".." -> Owner bekommt DM mit Embed + Buttons
 *  2. Owner klickt "Akzeptieren" -> Ticket OPEN, beide Seiten bekommen Bestaetigung
 *  3. Beide schreiben in ihre eigene DM mit dem Bot, Bot relayt -> Bridge
 *  4. /ticket close oder Owner-Button "Schliessen" -> Ticket CLOSED
 */

const OWNER_ID = (): string | null => config.discord.ownerId || null;

export interface CreateTicketResult {
  success: boolean;
  ticketNumber?: number;
  message: string;
}

export async function createTicket(opts: {
  client: Client;
  userDiscordId: string;
  username: string;
  guildId?: string | null;
  guildName?: string | null;
  subject: string;
  initialMessage: string;
}): Promise<CreateTicketResult> {
  const ownerId = OWNER_ID();
  if (!ownerId) {
    return { success: false, message: 'Bot-Owner ist nicht konfiguriert. Anfrage nicht moeglich.' };
  }

  // Rate-Limit: max. 1 PENDING-Ticket pro User
  const existing = await prisma.ticket.findFirst({
    where: { userDiscordId: opts.userDiscordId, status: { in: ['PENDING', 'OPEN'] } },
  });
  if (existing) {
    return {
      success: false,
      message: `Du hast bereits ein offenes Ticket (#${existing.ticketNumber}, Status: ${existing.status}). Schliesse es zuerst mit \`/ticket close\`.`,
    };
  }

  const ticket = await prisma.ticket.create({
    data: {
      userDiscordId: opts.userDiscordId,
      username: opts.username,
      guildId: opts.guildId ?? null,
      guildName: opts.guildName ?? null,
      subject: opts.subject.slice(0, 200),
      initialMessage: opts.initialMessage.slice(0, 4000),
      ownerDiscordId: ownerId,
    },
  });

  // Owner per DM benachrichtigen
  try {
    const owner = await opts.client.users.fetch(ownerId);
    const embed = vEmbed(Colors.Info)
      .setTitle(`📨  Neue Anfrage  ·  Ticket #${ticket.ticketNumber}`)
      .setDescription(
        `${Brand.divider}\n\n` +
        `**${opts.subject}**\n\n` +
        '```\n' + opts.initialMessage.slice(0, 1500) + '\n```\n' +
        Brand.divider
      )
      .addFields(
        { name: '👤 User', value: `${opts.username}\n\`${opts.userDiscordId}\``, inline: true },
        { name: '🌐 Server', value: opts.guildName ? `${opts.guildName}\n\`${opts.guildId}\`` : 'DM', inline: true },
        { name: '🆔 Ticket', value: `#${ticket.ticketNumber}`, inline: true },
      );

    const accept = new ButtonBuilder()
      .setCustomId(`ticket_accept_${ticket.id}`)
      .setLabel('Akzeptieren')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success);
    const deny = new ButtonBuilder()
      .setCustomId(`ticket_deny_${ticket.id}`)
      .setLabel('Ablehnen')
      .setEmoji('❌')
      .setStyle(ButtonStyle.Danger);
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(accept, deny);

    const sent = await owner.send({ embeds: [embed], components: [row] });
    await prisma.ticket.update({
      where: { id: ticket.id },
      data: { ownerNoticeMsgId: sent.id },
    });
  } catch (e) {
    logger.warn(`Ticket #${ticket.ticketNumber}: Owner-DM fehlgeschlagen`, { e: String(e) });
    await prisma.ticket.update({ where: { id: ticket.id }, data: { status: 'DENIED', closedAt: new Date() } });
    return { success: false, message: 'Konnte den Owner nicht per DM erreichen. Bitte spaeter erneut versuchen.' };
  }

  logAudit('TICKET_CREATED', 'TICKET', {
    ticketNumber: ticket.ticketNumber,
    userId: opts.userDiscordId,
    guildId: opts.guildId,
  });

  return {
    success: true,
    ticketNumber: ticket.ticketNumber,
    message: `Anfrage gesendet. Ticket #${ticket.ticketNumber} wurde erstellt. Du wirst per DM benachrichtigt, sobald geantwortet wird.`,
  };
}

export async function acceptTicket(ticketId: string, ownerDiscordId: string, client: Client): Promise<{ success: boolean; message: string }> {
  const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
  if (!ticket) return { success: false, message: 'Ticket nicht gefunden.' };
  if (ticket.status !== 'PENDING') return { success: false, message: `Ticket ist nicht mehr offen (Status: ${ticket.status}).` };
  if (ticket.ownerDiscordId !== ownerDiscordId) return { success: false, message: 'Du bist nicht der Empfaenger dieses Tickets.' };

  await prisma.ticket.update({ where: { id: ticketId }, data: { status: 'OPEN' } });

  // User benachrichtigen
  try {
    const user = await client.users.fetch(ticket.userDiscordId);
    await user.send({
      embeds: [
        vEmbed(Colors.Success)
          .setTitle(`✅  Ticket #${ticket.ticketNumber} angenommen`)
          .setDescription(
            'Der Owner hat deine Anfrage angenommen. Du kannst jetzt direkt hier in der DM mit ihm chatten – ich leite alles weiter.\n\n' +
            'Beende den Chat mit `/ticket close`.',
          ),
      ],
    });
  } catch (e) {
    logger.warn(`Ticket #${ticket.ticketNumber}: User-DM bei Accept fehlgeschlagen`, { e: String(e) });
  }

  logAudit('TICKET_ACCEPTED', 'TICKET', { ticketNumber: ticket.ticketNumber, ownerId: ownerDiscordId });
  return { success: true, message: `Ticket #${ticket.ticketNumber} ist jetzt offen. Schreib einfach in dieser DM, ich leite weiter.` };
}

export async function denyTicket(ticketId: string, ownerDiscordId: string, client: Client, reason?: string): Promise<{ success: boolean; message: string }> {
  const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
  if (!ticket) return { success: false, message: 'Ticket nicht gefunden.' };
  if (ticket.status !== 'PENDING') return { success: false, message: `Ticket ist nicht mehr offen (Status: ${ticket.status}).` };
  if (ticket.ownerDiscordId !== ownerDiscordId) return { success: false, message: 'Du bist nicht der Empfaenger dieses Tickets.' };

  await prisma.ticket.update({ where: { id: ticketId }, data: { status: 'DENIED', closedAt: new Date() } });

  try {
    const user = await client.users.fetch(ticket.userDiscordId);
    await user.send({
      embeds: [
        vEmbed(Colors.Error)
          .setTitle(`❌  Ticket #${ticket.ticketNumber} abgelehnt`)
          .setDescription(reason ? `Grund: ${reason}` : 'Der Owner hat deine Anfrage abgelehnt.'),
      ],
    });
  } catch { /* DM optional */ }

  logAudit('TICKET_DENIED', 'TICKET', { ticketNumber: ticket.ticketNumber, ownerId: ownerDiscordId });
  return { success: true, message: `Ticket #${ticket.ticketNumber} abgelehnt.` };
}

export async function closeTicket(ticketId: string, byDiscordId: string, client: Client): Promise<{ success: boolean; message: string }> {
  const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
  if (!ticket) return { success: false, message: 'Ticket nicht gefunden.' };
  if (ticket.status === 'CLOSED' || ticket.status === 'DENIED') {
    return { success: false, message: `Ticket ist bereits geschlossen (${ticket.status}).` };
  }
  if (ticket.userDiscordId !== byDiscordId && ticket.ownerDiscordId !== byDiscordId) {
    return { success: false, message: 'Du bist nicht Teil dieses Tickets.' };
  }

  await prisma.ticket.update({ where: { id: ticketId }, data: { status: 'CLOSED', closedAt: new Date() } });

  // Beide Seiten informieren
  for (const targetId of [ticket.userDiscordId, ticket.ownerDiscordId]) {
    if (targetId === byDiscordId) continue;
    try {
      const u = await client.users.fetch(targetId);
      await u.send({
        embeds: [
          vEmbed(Colors.Info)
            .setTitle(`🔒  Ticket #${ticket.ticketNumber} geschlossen`)
            .setDescription('Die Konversation wurde beendet.'),
        ],
      });
    } catch { /* ignore */ }
  }

  logAudit('TICKET_CLOSED', 'TICKET', { ticketNumber: ticket.ticketNumber, byUserId: byDiscordId });
  return { success: true, message: `Ticket #${ticket.ticketNumber} geschlossen.` };
}

/**
 * DM-Bridge: leitet eine DM-Nachricht in das aktive Ticket weiter.
 * Wird aus messageCreate.ts aufgerufen, wenn msg.guild == null.
 * Returns true wenn die Nachricht gehandled wurde.
 */
export async function handleTicketDm(msg: Message): Promise<boolean> {
  const userId = msg.author.id;
  // Aktives Ticket finden, an dem dieser Discord-User beteiligt ist (User oder Owner)
  const ticket = await prisma.ticket.findFirst({
    where: {
      status: 'OPEN',
      OR: [{ userDiscordId: userId }, { ownerDiscordId: userId }],
    },
    orderBy: { updatedAt: 'desc' },
  });
  if (!ticket) return false;

  const fromRole: 'USER' | 'OWNER' = ticket.userDiscordId === userId ? 'USER' : 'OWNER';
  const targetId = fromRole === 'USER' ? ticket.ownerDiscordId : ticket.userDiscordId;

  // Persistieren
  await prisma.ticketMessage.create({
    data: {
      ticketId: ticket.id,
      fromDiscordId: userId,
      fromRole,
      content: msg.content.slice(0, 4000),
    },
  });
  await prisma.ticket.update({ where: { id: ticket.id }, data: { updatedAt: new Date() } });

  // Weiterleiten
  try {
    const target = await msg.client.users.fetch(targetId);
    const senderLabel = fromRole === 'OWNER' ? `🛡️ Owner` : `👤 ${ticket.username}`;
    const header = `**${senderLabel}** · Ticket #${ticket.ticketNumber}`;
    const body = msg.content.slice(0, 1800);
    await target.send({
      content: `${header}\n${body}`,
      allowedMentions: { parse: [] },
    });
    // Bestaetigung an Sender (kurz, kein Spam)
    try { await msg.react('📨'); } catch { /* DM-React kann fehlschlagen */ }
  } catch (e) {
    logger.warn(`Ticket #${ticket.ticketNumber}: Relay-DM an ${targetId} fehlgeschlagen`, { e: String(e) });
    try {
      await msg.reply({
        content: `⚠️ Konnte Nachricht nicht zustellen (DM blockiert?). Ticket bleibt offen.`,
      });
    } catch { /* ignore */ }
  }
  return true;
}
