import { Router } from 'express';
import { requireBotAdmin } from '../../middleware/auth';
import { requireGlobalDeveloperIdentity } from '../../middleware/globalDeveloperGate';
import { tryGetDashboardClient } from '../../clientRegistry';
import { logAuditDb } from '../../../utils/logger';
import { replyToOwnerTicketFromDashboard } from '../../../modules/ticket/ticketDashboardReply';

export const botAdminTicketReplyRouter = Router();

botAdminTicketReplyRouter.post(
  '/:id/reply',
  requireGlobalDeveloperIdentity,
  requireBotAdmin,
  async (req, res) => {
    const rawContent = req.body?.content;
    if (typeof rawContent !== 'string') {
      res.status(400).json({ error: 'content muss ein String sein.' });
      return;
    }
    const content = rawContent.trim();
    if (content.length < 1 || content.length > 1800) {
      res.status(400).json({ error: 'content muss zwischen 1 und 1800 Zeichen lang sein.' });
      return;
    }

    const client = tryGetDashboardClient();
    if (!client) {
      res.status(503).json({ error: 'Discord-Client nicht verfügbar.' });
      return;
    }

    const result = await replyToOwnerTicketFromDashboard({
      ticketId: String(req.params.id),
      ownerDiscordId: req.auth!.discordId,
      content,
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
