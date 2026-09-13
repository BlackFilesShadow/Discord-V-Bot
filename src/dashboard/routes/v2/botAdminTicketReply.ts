import { Router, type Request, type RequestHandler, type Response } from 'express';
import multer from 'multer';
import { requireBotAdmin } from '../../middleware/auth';
import { requireGlobalDeveloperIdentity } from '../../middleware/globalDeveloperGate';
import { tryGetDashboardClient } from '../../clientRegistry';
import prisma from '../../../database/prisma';
import { logAuditDb } from '../../../utils/logger';
import { acceptTicket, denyTicket } from '../../../modules/ticket/ticketManager';
import { replyToOwnerTicketFromDashboard } from '../../../modules/ticket/ticketDashboardReply';
import {
  DISCORD_MAX_RELAY_ATTACHMENT_BYTES,
  downloadTicketRelayAttachmentBytes,
} from '../../../modules/ticket/ticketAttachmentRelay';
import {
  DASHBOARD_TICKET_REPLY_MAX_CHARS,
  decodeTicketMessageContent,
} from '../../../modules/ticket/ticketMessageEnvelope';
import { subscribeTicketRealtimeEvents } from '../../../modules/ticket/ticketRealtime';

export const botAdminTicketReplyRouter = Router();

const MAX_TICKET_UPLOADS = 10;
const MAX_TICKET_UPLOAD_TOTAL_BYTES = 50 * 1024 * 1024;
const ticketUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: MAX_TICKET_UPLOADS,
    fileSize: DISCORD_MAX_RELAY_ATTACHMENT_BYTES,
    fields: 4,
    fieldSize: 32 * 1024,
    parts: MAX_TICKET_UPLOADS + 4,
  },
}).array('files', MAX_TICKET_UPLOADS);

const parseTicketUpload: RequestHandler = (req, res, next) => {
  ticketUpload(req, res, (error: unknown) => {
    if (!error) { next(); return; }
    if (error instanceof multer.MulterError) {
      res.status(400).json({ error: `Ticket-Anhang abgelehnt: ${error.message}` });
      return;
    }
    next(error);
  });
};

function actionFailureStatus(message: string): number {
  if (message === 'Ticket nicht gefunden.') return 404;
  if (message.includes('nicht der Empfaenger')) return 403;
  return 409;
}

function auditTicketAction(req: Request, action: string, ticketId: string, details: Record<string, unknown> = {}): void {
  logAuditDb(action, 'TICKET', {
    actorUserId: req.auth!.userId,
    details: { ticketId, ...details },
    ip: req.ip,
    userAgent: req.get('user-agent') ?? null,
  });
}

function requireDiscordClient(res: Response) {
  const client = tryGetDashboardClient();
  if (!client) res.status(503).json({ error: 'Discord-Client nicht verfügbar.' });
  return client;
}

function previewableContentType(value: string | null): boolean {
  if (!value) return false;
  return /^(?:image\/(?:png|jpeg|gif|webp)|video\/(?:mp4|webm|ogg))$/i.test(value);
}

function safeFilename(value: string): string {
  const fallback = value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
  return fallback || 'attachment';
}

botAdminTicketReplyRouter.get(
  '/events',
  requireGlobalDeveloperIdentity,
  requireBotAdmin,
  (req, res) => {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write(`event: ready\ndata: ${JSON.stringify({ ok: true })}\n\n`);

    const unsubscribe = subscribeTicketRealtimeEvents(event => {
      res.write(`event: ticket-update\ndata: ${JSON.stringify(event)}\n\n`);
    });
    const keepAlive = setInterval(() => res.write(': keepalive\n\n'), 15_000);

    const cleanup = (): void => {
      clearInterval(keepAlive);
      unsubscribe();
    };
    req.once('close', cleanup);
    req.once('aborted', cleanup);
  },
);

botAdminTicketReplyRouter.get(
  '/:id/messages/:messageId/attachments/:index',
  requireBotAdmin,
  async (req, res) => {
    const rawIndex = String(req.params.index);
    if (!/^\d+$/.test(rawIndex)) {
      res.status(400).json({ error: 'Attachment-Index ist ungueltig.' });
      return;
    }
    const index = Number.parseInt(rawIndex, 10);
    const ticketId = String(req.params.id);
    const messageId = String(req.params.messageId);

    const message = await prisma.ticketMessage.findFirst({
      where: { id: messageId, ticketId },
      select: { content: true },
    });
    if (!message) {
      res.status(404).json({ error: 'Ticket-Nachricht nicht gefunden.' });
      return;
    }

    const decoded = decodeTicketMessageContent(message.content);
    const metadata = decoded.attachments[index];
    if (!metadata || !decoded.relay) {
      res.status(404).json({ error: 'Anhang ist nicht verfügbar.' });
      return;
    }

    const client = requireDiscordClient(res);
    if (!client) return;
    const channel = await client.channels.fetch(decoded.relay.channelId).catch(() => null);
    if (!channel?.isTextBased()) {
      res.status(404).json({ error: 'Relay-Nachricht ist nicht mehr verfügbar.' });
      return;
    }
    const relayMessage = await channel.messages.fetch(decoded.relay.messageId).catch(() => null);
    if (!relayMessage) {
      res.status(404).json({ error: 'Relay-Nachricht ist nicht mehr verfügbar.' });
      return;
    }
    const receipt = [...relayMessage.attachments.values()][index];
    if (!receipt || receipt.size !== metadata.size) {
      res.status(409).json({ error: 'Anhang-Metadaten stimmen nicht mehr mit Discord überein.' });
      return;
    }

    const bytes = await downloadTicketRelayAttachmentBytes(receipt.url, receipt.size, metadata.name);
    const contentType = receipt.contentType ?? metadata.contentType ?? 'application/octet-stream';
    const disposition = previewableContentType(contentType) ? 'inline' : 'attachment';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', String(bytes.length));
    res.setHeader('Content-Disposition', `${disposition}; filename="${safeFilename(metadata.name)}"; filename*=UTF-8''${encodeURIComponent(metadata.name)}`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(bytes);
  },
);

botAdminTicketReplyRouter.get(
  '/:id',
  requireBotAdmin,
  async (req, res) => {
    const ticket = await prisma.ticket.findUnique({
      where: { id: String(req.params.id) },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
    if (!ticket) {
      res.status(404).json({ error: 'Ticket nicht gefunden.' });
      return;
    }

    res.json({
      ...ticket,
      messages: ticket.messages.map(message => {
        const decoded = decodeTicketMessageContent(message.content);
        return {
          ...message,
          content: decoded.text,
          attachments: decoded.attachments.map((attachment, index) => ({
            ...attachment,
            available: decoded.relay !== null,
            url: decoded.relay
              ? `/api/v2/bot-admin/tickets/${ticket.id}/messages/${message.id}/attachments/${index}`
              : null,
          })),
        };
      }),
    });
  },
);

botAdminTicketReplyRouter.post(
  '/:id/accept',
  requireGlobalDeveloperIdentity,
  requireBotAdmin,
  async (req, res) => {
    const ticketId = String(req.params.id);
    const client = requireDiscordClient(res);
    if (!client) return;

    const result = await acceptTicket(ticketId, req.auth!.discordId, client);
    if (!result.success) {
      res.status(actionFailureStatus(result.message)).json({ error: result.message });
      return;
    }

    auditTicketAction(req, 'BOTADMIN_TICKET_ACCEPT', ticketId);
    res.json({ success: true, message: result.message });
  },
);

botAdminTicketReplyRouter.post(
  '/:id/deny',
  requireGlobalDeveloperIdentity,
  requireBotAdmin,
  async (req, res) => {
    const rawReason = req.body?.reason;
    if (rawReason !== undefined && typeof rawReason !== 'string') {
      res.status(400).json({ error: 'reason muss ein String sein.' });
      return;
    }
    const reason = typeof rawReason === 'string' ? rawReason.trim() : '';
    if (reason.length > 1000) {
      res.status(400).json({ error: 'reason darf maximal 1000 Zeichen lang sein.' });
      return;
    }

    const ticketId = String(req.params.id);
    const client = requireDiscordClient(res);
    if (!client) return;

    const result = await denyTicket(ticketId, req.auth!.discordId, client, reason || undefined);
    if (!result.success) {
      res.status(actionFailureStatus(result.message)).json({ error: result.message });
      return;
    }

    auditTicketAction(req, 'BOTADMIN_TICKET_DENY', ticketId, { reasonProvided: reason.length > 0 });
    res.json({ success: true, message: result.message });
  },
);

botAdminTicketReplyRouter.post(
  '/:id/reply',
  requireGlobalDeveloperIdentity,
  requireBotAdmin,
  parseTicketUpload,
  async (req, res) => {
    const files = Array.isArray(req.files) ? req.files : [];
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    if (totalBytes > MAX_TICKET_UPLOAD_TOTAL_BYTES) {
      res.status(400).json({ error: 'Ticket-Anhänge dürfen zusammen maximal 50 MiB groß sein.' });
      return;
    }

    const rawContent = req.body?.content ?? '';
    if (typeof rawContent !== 'string') {
      res.status(400).json({ error: 'content muss ein String sein.' });
      return;
    }
    const content = rawContent.trim();
    if ((content.length < 1 && files.length === 0) || content.length > DASHBOARD_TICKET_REPLY_MAX_CHARS) {
      res.status(400).json({
        error: `Antwort muss Text oder mindestens einen Anhang enthalten und darf maximal ${DASHBOARD_TICKET_REPLY_MAX_CHARS} Zeichen lang sein.`,
      });
      return;
    }

    const client = requireDiscordClient(res);
    if (!client) return;

    const result = await replyToOwnerTicketFromDashboard({
      ticketId: String(req.params.id),
      ownerDiscordId: req.auth!.discordId,
      content,
      attachments: files.map(file => ({
        name: file.originalname,
        contentType: file.mimetype || null,
        size: file.size,
        bytes: file.buffer,
      })),
      client,
    });

    if (!result.ok) {
      if (result.recorded) {
        logAuditDb('BOTADMIN_TICKET_REPLY_DELIVERY_FAILED', 'TICKET', {
          actorUserId: req.auth!.userId,
          targetUserId: result.userDiscordId ?? null,
          details: {
            ticketId: String(req.params.id),
            ticketNumber: result.ticketNumber ?? null,
            code: result.code,
            recorded: true,
            delivered: false,
            attachmentCount: files.length,
          },
          ip: req.ip,
          userAgent: req.get('user-agent') ?? null,
        });
      }

      const status = result.code === 'NOT_FOUND'
        ? 404
        : result.code === 'NOT_OWNER'
          ? 403
          : result.code === 'NOT_OPEN'
            ? 409
            : 502;
      res.status(status).json({
        error: result.message,
        code: result.code,
        recorded: result.recorded,
        delivered: result.delivered,
      });
      return;
    }

    logAuditDb('BOTADMIN_TICKET_REPLY', 'TICKET', {
      actorUserId: req.auth!.userId,
      targetUserId: result.userDiscordId,
      details: {
        ticketId: String(req.params.id),
        ticketNumber: result.ticketNumber,
        recorded: true,
        delivered: true,
        attachmentCount: files.length,
      },
      ip: req.ip,
      userAgent: req.get('user-agent') ?? null,
    });

    res.json({
      success: true,
      ticketNumber: result.ticketNumber,
      recorded: true,
      delivered: true,
    });
  },
);
