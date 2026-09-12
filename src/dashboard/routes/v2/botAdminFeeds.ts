import { Router, type Request, type Response } from 'express';
import prisma from '../../../database/prisma';
import { createCanonicalFeed, FEED_TYPES } from '../../services/feedControlPlane';
import { logAuditDb } from '../../../utils/logger';

export const botAdminFeedsRouter = Router();

const SNOWFLAKE_RE = /^\d{17,20}$/;
const STABLE_CREATED_DESC = [{ createdAt: 'desc' as const }, { id: 'desc' as const }];

function reqGuildId(req: Request, res: Response): string | null {
  const raw = req.query.guildId ?? (req.body as { guildId?: unknown } | undefined)?.guildId;
  const guildId = typeof raw === 'string' ? raw.trim() : Array.isArray(raw) ? String(raw[0]).trim() : '';
  if (!SNOWFLAKE_RE.test(guildId)) {
    res.status(400).json({ error: 'guildId fehlt oder ist ungueltig.' });
    return null;
  }
  return guildId;
}

function audit(
  req: Request,
  action: string,
  details: Record<string, unknown>,
  opts: { channelId?: string | null; guildId?: string | null } = {},
): void {
  logAuditDb(action, 'FEED', {
    actorUserId: req.auth!.userId,
    guildId: opts.guildId ?? null,
    channelId: opts.channelId ?? null,
    details,
    ip: req.ip,
    userAgent: req.get('user-agent') ?? null,
  });
}

botAdminFeedsRouter.get('/', async (req, res) => {
  const guildId = reqGuildId(req, res);
  if (!guildId) return;

  const feeds = await prisma.feed.findMany({ where: { guildId }, orderBy: STABLE_CREATED_DESC });
  res.json({
    items: feeds.map(({ webhookSecret, credentialsEnc, ...rest }) => ({
      ...rest,
      hasWebhookSecret: webhookSecret != null,
      hasCredentials: credentialsEnc != null,
    })),
  });
});

botAdminFeedsRouter.post('/', async (req, res) => {
  const guildId = reqGuildId(req, res);
  if (!guildId) return;

  const created = await createCanonicalFeed({
    guildId,
    createdBy: req.auth!.discordId,
    body: (req.body ?? {}) as Record<string, unknown>,
  });
  if (!created.ok) {
    res.status(400).json({ error: created.error });
    return;
  }

  audit(
    req,
    'BOTADMIN_FEED_CREATE',
    {
      feedId: created.feedId,
      feedType: created.feedType,
      channelId: created.channelId,
      sourceId: created.sourceId,
      credentialsSet: created.credentialsSet,
    },
    { channelId: created.channelId, guildId },
  );
  res.status(201).json({ id: created.feedId });
});

botAdminFeedsRouter.post('/:id/toggle', async (req, res) => {
  const guildId = reqGuildId(req, res);
  if (!guildId) return;

  const feed = await prisma.feed.findFirst({ where: { id: String(req.params.id), guildId } });
  if (!feed) {
    res.status(404).json({ error: 'Feed nicht gefunden.' });
    return;
  }

  const nextActive = !feed.isActive;
  if (nextActive && !FEED_TYPES.has(feed.feedType as never)) {
    res.status(409).json({ error: `Legacy-Feed-Typ ${feed.feedType} wird nicht mehr unterstützt. Bitte neu als unterstützten Feed anlegen.` });
    return;
  }

  const updated = await prisma.feed.update({ where: { id: feed.id }, data: { isActive: nextActive } });
  audit(req, 'BOTADMIN_FEED_TOGGLE', { feedId: feed.id, isActive: updated.isActive }, { guildId });
  res.json({ id: updated.id, isActive: updated.isActive });
});

botAdminFeedsRouter.delete('/:id', async (req, res) => {
  const guildId = reqGuildId(req, res);
  if (!guildId) return;

  const feed = await prisma.feed.findFirst({ where: { id: String(req.params.id), guildId } });
  if (!feed) {
    res.status(404).json({ error: 'Feed nicht gefunden.' });
    return;
  }

  await prisma.feed.delete({ where: { id: feed.id } });
  audit(req, 'BOTADMIN_FEED_DELETE', { feedId: feed.id }, { guildId });
  res.json({ deleted: true });
});
