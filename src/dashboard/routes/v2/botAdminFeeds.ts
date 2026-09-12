import { Router, type Request, type Response } from 'express';
import {
  addCanonicalFeedRole,
  createCanonicalFeed,
  deleteCanonicalFeed,
  feedControlHttpStatus,
  feedToApi,
  findCanonicalFeed,
  getCanonicalFeedWebhook,
  listCanonicalFeeds,
  removeCanonicalFeedRole,
  rotateCanonicalFeedWebhook,
  testCanonicalFeed,
  toggleCanonicalFeed,
  updateCanonicalFeed,
  type FeedControlFailure,
} from '../../services/feedControlPlane';
import { tryGetDashboardClient } from '../../clientRegistry';
import { logAuditDb } from '../../../utils/logger';

export const botAdminFeedsRouter = Router();

const SNOWFLAKE_RE = /^\d{17,20}$/;

function reqGuildId(req: Request, res: Response): string | null {
  const raw = req.query.guildId ?? (req.body as { guildId?: unknown } | undefined)?.guildId;
  const guildId = typeof raw === 'string' ? raw.trim() : Array.isArray(raw) ? String(raw[0]).trim() : '';
  if (!SNOWFLAKE_RE.test(guildId)) {
    res.status(400).json({ error: 'guildId fehlt oder ist ungueltig.' });
    return null;
  }
  return guildId;
}

function respondFailure(res: Response, result: FeedControlFailure): void {
  res.status(feedControlHttpStatus(result.code)).json({ error: result.error });
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

botAdminFeedsRouter.get('/channels', async (req, res) => {
  const guildId = reqGuildId(req, res);
  if (!guildId) return;
  const guild = tryGetDashboardClient()?.guilds.cache.get(guildId);
  if (!guild) { res.status(404).json({ error: 'Bot ist nicht in dieser Guild.' }); return; }
  const channels = [...guild.channels.cache.values()]
    .filter((channel) => channel.type === 0 || channel.type === 5)
    .map((channel) => ({ id: channel.id, name: channel.name, type: channel.type, parentId: channel.parentId ?? null }))
    .sort((a, b) => a.name.localeCompare(b.name));
  res.json({ channels });
});

botAdminFeedsRouter.get('/roles', async (req, res) => {
  const guildId = reqGuildId(req, res);
  if (!guildId) return;
  const guild = tryGetDashboardClient()?.guilds.cache.get(guildId);
  if (!guild) { res.status(404).json({ error: 'Bot ist nicht in dieser Guild.' }); return; }
  const roles = [...guild.roles.cache.values()]
    .map((role) => ({ id: role.id, name: role.name, color: role.hexColor, position: role.position, managed: role.managed }))
    .sort((a, b) => b.position - a.position);
  res.json({ roles });
});

botAdminFeedsRouter.get('/', async (req, res) => {
  const guildId = reqGuildId(req, res);
  if (!guildId) return;
  const feeds = await listCanonicalFeeds(guildId);
  res.json({ items: feeds.map(feedToApi) });
});

botAdminFeedsRouter.post('/', async (req, res) => {
  const guildId = reqGuildId(req, res);
  if (!guildId) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const created = await createCanonicalFeed({ guildId, createdBy: req.auth!.discordId, body });
  if (!created.ok) { res.status(400).json({ error: created.error }); return; }
  const feed = await findCanonicalFeed(guildId, created.feedId);
  if (!feed) { res.status(409).json({ error: 'Feed wurde erstellt, konnte danach aber nicht geladen werden.' }); return; }
  audit(req, 'BOTADMIN_FEED_CREATE', {
    feedId: created.feedId,
    feedType: created.feedType,
    channelId: created.channelId,
    sourceId: created.sourceId,
    credentialsSet: created.credentialsSet,
  }, { channelId: created.channelId, guildId });
  res.status(201).json(feedToApi(feed));
});

botAdminFeedsRouter.put('/:id', async (req, res) => {
  const guildId = reqGuildId(req, res);
  if (!guildId) return;
  const result = await updateCanonicalFeed({ guildId, id: String(req.params.id), body: (req.body ?? {}) as Record<string, unknown> });
  if (!result.ok) { respondFailure(res, result); return; }
  audit(req, 'BOTADMIN_FEED_UPDATE', { feedId: result.feed.id, credentialsChanged: result.credentialsChanged }, { channelId: result.feed.channelId, guildId });
  res.json(feedToApi(result.feed));
});

botAdminFeedsRouter.post('/:id/toggle', async (req, res) => {
  const guildId = reqGuildId(req, res);
  if (!guildId) return;
  const requested = typeof req.body?.isActive === 'boolean' ? req.body.isActive : undefined;
  const result = await toggleCanonicalFeed({ guildId, id: String(req.params.id), isActive: requested });
  if (!result.ok) { respondFailure(res, result); return; }
  audit(req, 'BOTADMIN_FEED_TOGGLE', { feedId: result.feed.id, isActive: result.isActive }, { guildId });
  res.json({ id: result.feed.id, isActive: result.isActive });
});

botAdminFeedsRouter.post('/:id/test', async (req, res) => {
  const guildId = reqGuildId(req, res);
  if (!guildId) return;
  const result = await testCanonicalFeed(guildId, String(req.params.id));
  if (!result.ok) { respondFailure(res, result); return; }
  audit(req, 'BOTADMIN_FEED_TEST', { feedId: result.feed.id }, { guildId });
  res.json({ ok: true });
});

botAdminFeedsRouter.post('/:id/roles', async (req, res) => {
  const guildId = reqGuildId(req, res);
  if (!guildId) return;
  const roleId = typeof req.body?.roleId === 'string' ? req.body.roleId.trim() : '';
  const result = await addCanonicalFeedRole(guildId, String(req.params.id), roleId);
  if (!result.ok) { respondFailure(res, result); return; }
  audit(req, 'BOTADMIN_FEED_ROLE_ADDED', { feedId: result.feed.id, roleId }, { guildId });
  res.json({ ok: true, mentionRoles: result.mentionRoles });
});

botAdminFeedsRouter.delete('/:id/roles/:roleId', async (req, res) => {
  const guildId = reqGuildId(req, res);
  if (!guildId) return;
  const roleId = String(req.params.roleId);
  const result = await removeCanonicalFeedRole(guildId, String(req.params.id), roleId);
  if (!result.ok) { respondFailure(res, result); return; }
  audit(req, 'BOTADMIN_FEED_ROLE_REMOVED', { feedId: result.feed.id, roleId }, { guildId });
  res.json({ ok: true, mentionRoles: result.mentionRoles });
});

botAdminFeedsRouter.get('/:id/webhook', async (req, res) => {
  const guildId = reqGuildId(req, res);
  if (!guildId) return;
  const result = await getCanonicalFeedWebhook(guildId, String(req.params.id));
  if (!result.ok) { respondFailure(res, result); return; }
  res.json({ webhookUrl: result.webhookUrl, secret: result.secret, hmacHeader: result.hmacHeader });
});

botAdminFeedsRouter.post('/:id/webhook/rotate', async (req, res) => {
  const guildId = reqGuildId(req, res);
  if (!guildId) return;
  const result = await rotateCanonicalFeedWebhook(guildId, String(req.params.id));
  if (!result.ok) { respondFailure(res, result); return; }
  audit(req, 'BOTADMIN_FEED_WEBHOOK_SECRET_ROTATED', { feedId: result.feed.id }, { guildId });
  res.json({ ok: true, secret: result.secret });
});

botAdminFeedsRouter.delete('/:id', async (req, res) => {
  const guildId = reqGuildId(req, res);
  if (!guildId) return;
  const result = await deleteCanonicalFeed(guildId, String(req.params.id));
  if (!result.ok) { respondFailure(res, result); return; }
  audit(req, 'BOTADMIN_FEED_DELETE', { feedId: result.feed.id }, { guildId });
  res.json({ deleted: true });
});
