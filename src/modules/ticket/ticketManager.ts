/* eslint-disable local/no-unscoped-prisma-query -- Stage 64: guild boundary enforced at auth/API or entity-id unique after prior guild check; Prisma update/delete require unique where. */
import {
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  Client,
  Message,
} from 'discord.js';
import prisma from '../../database/prisma';
import { config } from '../../config';
import { logger, logAudit } from '../../utils/logger';
import { Colors, Brand, vEmbed } from '../../utils/embedDesign';

/**
 * Legacy Owner-DM-Bridge fuer /ticket.
 *
 * Sicherheits-/Routing-Invarianten:
 * - Accept/Deny/Close nutzen CAS-Updates auf den aktuellen Status.
 * - Ein nachgelagertes Fehler beim Speichern der Notice-Message-ID macht ein
 *   bereits erfolgreich zugestelltes Ticket nicht faelschlich DENIED.
 * - User haben weiterhin hoechstens ein aktives Bridge-Ticket.
 * - Hat der Owner mehrere OPEN-Tickets, wird niemals nach "zuletzt geaendert"
 *   geraten. Dann ist eine eindeutige Discord-Reply-Referenz mit Ticketnummer
 *   erforderlich.
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
  if (opts.userDiscordId === ownerId) {
    return { success: false, message: 'Als Bot-Owner kannst du kein Ticket an dich selbst stellen.' };
  }

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

  let sentMessageId: string;
  try {
    const owner = await opts.client.users.fetch(ownerId);
    const embed = vEmbed(Colors.Info)
      .setTitle(`📨  Neue Anfrage  ·  Ticket #${ticket.ticketNumber}`)
      .setDescription(
        `${Brand.divider}\n\n` +
        `**${opts.subject}**\n\n` +
        '```\n' + opts.initialMessage.slice(0, 1500) + '\n```\n' +
        Brand.divider,
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
    sentMessageId = sent.id;
  } catch (e) {
    logger.warn(`Ticket #${ticket.ticketNumber}: Owner-DM fehlgeschlagen`, { e: String(e) });
    await prisma.ticket.updateMany({
      where: { id: ticket.id, status: 'PENDING' },
      data: { status: 'DENIED', closedAt: new Date() },
    });
    return { success: false, message: 'Konnte den Owner nicht per DM erreichen. Bitte spaeter erneut versuchen.' };
  }

  await prisma.ticket.update({
    where: { id: ticket.id },
    data: { ownerNoticeMsgId: sentMessageId },
  }).catch(e => {
    logger.warn(`Ticket #${ticket.ticketNumber}: ownerNoticeMsgId konnte nicht gespeichert werden`, { e: String(e) });
  });

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

export async function acceptTicket(
  ticketId: string,
  ownerDiscordId: string,
  client: Client,
): Promise<{ success: boolean; message: string }> {
  const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
  if (!ticket) return { success: false, message: 'Ticket nicht gefunden.' };
  if (ticket.ownerDiscordId !== ownerDiscordId) return { success: false, message: 'Du bist nicht der Empfaenger dieses Tickets.' };

  const claimed = await prisma.ticket.updateMany({
    where: { id: ticketId, ownerDiscordId, status: 'PENDING' },
    data: { status: 'OPEN' },
  });
  if (claimed.count !== 1) {
    const current = await prisma.ticket.findUnique({ where: { id: ticketId }, select: { status: true } });
    return { success: false, message: `Ticket wurde bereits bearbeitet (Status: ${current?.status ?? 'unbekannt'}).` };
  }

  try {
    const user = await client.users.fetch(ticket.userDiscordId);
    await user.send({
      embeds: [
        vEmbed(Colors.Success)
          .setTitle(`✅  Ticket #${ticket.ticketNumber} angenommen`)
          .setDescription(
            'Der Owner hat deine Anfrage angenommen.\n\n' +
            '**So antwortest du:**\n' +
            '➜ Schreib einfach hier in dieser DM an mich – jede Nachricht wird automatisch an den Owner weitergeleitet.\n' +
            '➜ Antworten vom Owner bekommst du ebenfalls hier in der DM.\n\n' +
            'Beende den Chat jederzeit mit `/ticket close`.',
          ),
      ],
    });
  } catch (e) {
    logger.warn(`Ticket #${ticket.ticketNumber}: User-DM bei Accept fehlgeschlagen`, { e: String(e) });
  }

  logAudit('TICKET_ACCEPTED', 'TICKET', { ticketNumber: ticket.ticketNumber, ownerId: ownerDiscordId });
  return { success: true, message: `Ticket #${ticket.ticketNumber} ist jetzt offen.` };
}

export async function denyTicket(
  ticketId: string,
  ownerDiscordId: string,
  client: Client,
  reason?: string,
): Promise<{ success: boolean; message: string }> {
  const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
  if (!ticket) return { success: false, message: 'Ticket nicht gefunden.' };
  if (ticket.ownerDiscordId !== ownerDiscordId) return { success: false, message: 'Du bist nicht der Empfaenger dieses Tickets.' };

  const claimed = await prisma.ticket.updateMany({
    where: { id: ticketId, ownerDiscordId, status: 'PENDING' },
    data: { status: 'DENIED', closedAt: new Date() },
  });
  if (claimed.count !== 1) {
    const current = await prisma.ticket.findUnique({ where: { id: ticketId }, select: { status: true } });
    return { success: false, message: `Ticket wurde bereits bearbeitet (Status: ${current?.status ?? 'unbekannt'}).` };
  }

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

export async function closeTicket(
  ticketId: string,
  byDiscordId: string,
  client: Client,
): Promise<{ success: boolean; message: string }> {
  const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
  if (!ticket) return { success: false, message: 'Ticket nicht gefunden.' };
  if (ticket.userDiscordId !== byDiscordId && ticket.ownerDiscordId !== byDiscordId) {
    return { success: false, message: 'Du bist nicht Teil dieses Tickets.' };
  }

  const closed = await prisma.ticket.updateMany({
    where: { id: ticketId, status: { in: ['PENDING', 'OPEN'] } },
    data: { status: 'CLOSED', closedAt: new Date() },
  });
  if (closed.count !== 1) {
    const current = await prisma.ticket.findUnique({ where: { id: ticketId }, select: { status: true } });
    return { success: false, message: `Ticket ist bereits beendet (${current?.status ?? 'unbekannt'}).` };
  }

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
    } catch { /* DM optional */ }
  }

  logAudit('TICKET_CLOSED', 'TICKET', { ticketNumber: ticket.ticketNumber, byUserId: byDiscordId });
  return { success: true, message: `Ticket #${ticket.ticketNumber} geschlossen.` };
}

function ticketNumberFromReferencedMessage(message: Message): number | null {
  const candidates = [
    message.content,
    ...message.embeds.flatMap(embed => [embed.title ?? '', embed.description ?? '']),
  ];
  for (const value of candidates) {
    const match = /Ticket\s*#(\d+)/i.exec(value);
    if (!match) continue;
    const parsed = Number.parseInt(match[1], 10);
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  return null;
}

async function resolveOwnerTicketByReply(msg: Message, openTickets: Array<{ ticketNumber: number }>): Promise<number | null> {
  if (!msg.reference?.messageId) return null;
  const referenced = await msg.fetchReference().catch(() => null);
  if (!referenced) return null;
  const number = ticketNumberFromReferencedMessage(referenced);
  if (!number) return null;
  return openTickets.some(t => t.ticketNumber === number) ? number : null;
}

export async function handleTicketDm(msg: Message): Promise<boolean> {
  const userId = msg.author.id;
  const tickets = await prisma.ticket.findMany({
    where: {
      status: 'OPEN',
      OR: [{ userDiscordId: userId }, { ownerDiscordId: userId }],
    },
    orderBy: { updatedAt: 'desc' },
    take: 50,
  });
  if (tickets.length === 0) return false;

  const asUser = tickets.filter(t => t.userDiscordId === userId);
  const asOwner = tickets.filter(t => t.ownerDiscordId === userId);
  let ticket: (typeof tickets)[number] | null = asUser[0] ?? null;

  if (!ticket && asOwner.length === 1) {
    ticket = asOwner[0];
  } else if (!ticket && asOwner.length > 1) {
    const referencedNumber = await resolveOwnerTicketByReply(msg, asOwner);
    ticket = referencedNumber
      ? asOwner.find(t => t.ticketNumber === referencedNumber) ?? null
      : null;
    if (!ticket) {
      const list = asOwner.slice(0, 15).map(t => `• Ticket #${t.ticketNumber} · ${t.username} · ${t.subject.slice(0, 70)}`).join('\n');
      await msg.reply({
        embeds: [
          vEmbed(Colors.Info)
            .setTitle('🎟️  Ticket eindeutig auswaehlen')
            .setDescription(
              'Du hast mehrere offene Tickets. Aus Sicherheitsgruenden rate ich **nicht**, wohin diese Nachricht gehoert.\n\n' +
              'Nutze Discord **Antworten** auf eine Bot-Nachricht des gewuenschten Tickets und sende deine Antwort erneut.\n\n' +
              list,
            ),
        ],
        allowedMentions: { parse: [] },
      }).catch(() => undefined);
      return true;
    }
  }

  if (!ticket) return false;

  const fromRole: 'USER' | 'OWNER' = ticket.userDiscordId === userId ? 'USER' : 'OWNER';
  const targetId = fromRole === 'USER' ? ticket.ownerDiscordId : ticket.userDiscordId;

  await prisma.ticketMessage.create({
    data: {
      ticketId: ticket.id,
      fromDiscordId: userId,
      fromRole,
      content: msg.content.slice(0, 4000),
    },
  });
  await prisma.ticket.update({ where: { id: ticket.id }, data: { updatedAt: new Date() } });

  try {
    const target = await msg.client.users.fetch(targetId);
    const senderLabel = fromRole === 'OWNER' ? '🛡️ Owner' : `👤 ${ticket.username}`;
    const header = `**${senderLabel}** · Ticket #${ticket.ticketNumber}`;
    const body = msg.content.slice(0, 1800);
    await target.send({ content: `${header}\n${body}`, allowedMentions: { parse: [] } });
    try { await msg.react('📨'); } catch { /* optional */ }
    try {
      await msg.reply({
        content: `↳ weitergeleitet · Ticket #${ticket.ticketNumber}`,
        allowedMentions: { parse: [] },
      });
    } catch { /* optional */ }
  } catch (e) {
    logger.warn(`Ticket #${ticket.ticketNumber}: Relay-DM an ${targetId} fehlgeschlagen`, { e: String(e) });
    try {
      await msg.reply({
        embeds: [
          vEmbed(Colors.Warning)
            .setTitle(`⚠️  Ticket #${ticket.ticketNumber} nicht zugestellt`)
            .setDescription('Der Empfaenger konnte per DM nicht erreicht werden. Das Ticket bleibt offen.'),
        ],
        allowedMentions: { parse: [] },
      });
    } catch { /* optional */ }
    logAudit('TICKET_RELAY_FAILED', 'TICKET', {
      ticketNumber: ticket.ticketNumber,
      fromRole,
      targetId,
    });
  }
  return true;
}
