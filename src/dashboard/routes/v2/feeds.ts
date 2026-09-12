/**
 * Feeds-Routen — Live-Feeds (RSS, News, Twitch, Steam, YouTube, Webhook) pro Guild.
 * Dashboard-only: der frühere Slash-Command /feed wurde hierher migriert.
 *
 * Fachlogik und Persistenz-Mutationen laufen über feedControlPlane.ts. Diese
 * Route besitzt nur Guild-Auth, Audit und Socket-Emissionen. Dadurch teilen
 * Guild-Dashboard und BotAdmin dieselbe Feed-Control-Plane, ohne ihre
 * Autorisierungsgrenzen zu vermischen.
 */

import { Router, type Response } from 'express';
import { requireGuildPermission } from '../../middleware/auth';
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
import { logAuditDb } from '../../../utils/logger';
import { emitGuildEvent } from '../../socket/emitter';

export const feedsRouter = Router({ mergeParams: true });

function respondFailure(res: Response, result: FeedControlFailure): void {
  res.status(feedControlHttpStatus(result.code)).json({ error: result.error });
}

feedsRouter.get('/', requireGuildPermission('feeds.view'), async (req, res) => {
  const { guildId } = req.guildScope!;
  const feeds = await listCanonicalFeeds(guildId);
  res.json({ feeds: feeds.map(feedToApi) });
});

feedsRouter.get('/:id', requireGuildPermission('feeds.view'), async (req, res) => {
  const { guildId } = req.guildScope!;
  const feed = await findCanonicalFeed(guildId, String(req.params.id));
  if (!feed) { res.status(404).json({ error: 'Feed nicht gefunden.' }); return; }
  res.json(feedToApi(feed));
});

feedsRouter.post('/', requireGuildPermission('feeds.manage'), async (req, res) => {
  const { guildId, actorDiscordId } = req.guildScope!;
  const created = await createCanonicalFeed({
    guildId,
    createdBy: actorDiscordId,
    body: (req.body ?? {}) as Record<string, unknown>,
  });
  if (!created.ok) { res.status(400).json({ error: created.error }); return; }

  const feed = await findCanonicalFeed(guildId, created.feedId);
  if (!feed) { res.status(409).json({ error: 'Feed wurde erstellt, konnte danach aber nicht geladen werden.' }); return; }
  logAuditDb('FEED_CREATED', 'FEED', {
    actorUserId: req.auth!.userId,
    guildId,
    details: {
      feedId: created.feedId,
      name: created.name,
      feedType: created.feedType,
      credentialsSet: created.credentialsSet,
    },
  });
  emitGuildEvent(guildId, { type: 'feed.changed', payload: { guildId, feedId: created.feedId } });
  res.status(201).json(feedToApi(feed));
});

feedsRouter.put('/:id', requireGuildPermission('feeds.manage'), async (req, res) => {
  const { guildId } = req.guildScope!;
  const result = await updateCanonicalFeed({
    guildId,
    id: String(req.params.id),
    body: (req.body ?? {}) as Record<string, unknown>,
  });
  if (!result.ok) { respondFailure(res, result); return; }

  logAuditDb('FEED_UPDATED', 'FEED', {
    actorUserId: req.auth!.userId,
    guildId,
    details: { feedId: result.feed.id, credentialsChanged: result.credentialsChanged },
  });
  emitGuildEvent(guildId, { type: 'feed.changed', payload: { guildId, feedId: result.feed.id } });
  res.json(feedToApi(result.feed));
});

feedsRouter.delete('/:id', requireGuildPermission('feeds.manage'), async (req, res) => {
  const { guildId } = req.guildScope!;
  const result = await deleteCanonicalFeed(guildId, String(req.params.id));
  if (!result.ok) { respondFailure(res, result); return; }

  logAuditDb('FEED_DELETED', 'FEED', {
    actorUserId: req.auth!.userId,
    guildId,
    details: { feedId: result.feed.id, name: result.feed.name },
  });
  emitGuildEvent(guildId, { type: 'feed.changed', payload: { guildId, feedId: result.feed.id } });
  res.json({ ok: true });
});

feedsRouter.post('/:id/toggle', requireGuildPermission('feeds.manage'), async (req, res) => {
  const { guildId } = req.guildScope!;
  const result = await toggleCanonicalFeed({
    guildId,
    id: String(req.params.id),
    isActive: typeof req.body?.isActive === 'boolean' ? req.body.isActive : undefined,
  });
  if (!result.ok) { respondFailure(res, result); return; }

  logAuditDb('FEED_TOGGLED', 'FEED', {
    actorUserId: req.auth!.userId,
    guildId,
    details: { feedId: result.feed.id, isActive: result.isActive },
  });
  emitGuildEvent(guildId, { type: 'feed.changed', payload: { guildId, feedId: result.feed.id } });
  res.json({ ok: true, isActive: result.isActive });
});

feedsRouter.post('/:id/test', requireGuildPermission('feeds.manage'), async (req, res) => {
  const { guildId } = req.guildScope!;
  const result = await testCanonicalFeed(guildId, String(req.params.id));
  if (!result.ok) { respondFailure(res, result); return; }

  logAuditDb('FEED_TESTED', 'FEED', {
    actorUserId: req.auth!.userId,
    guildId,
    details: { feedId: result.feed.id },
  });
  res.json({ ok: true });
});

feedsRouter.post('/:id/roles', requireGuildPermission('feeds.manage'), async (req, res) => {
  const { guildId } = req.guildScope!;
  const roleId = typeof req.body?.roleId === 'string' ? req.body.roleId.trim() : '';
  const result = await addCanonicalFeedRole(guildId, String(req.params.id), roleId);
  if (!result.ok) { respondFailure(res, result); return; }

  logAuditDb('FEED_ROLE_ADDED', 'FEED', {
    actorUserId: req.auth!.userId,
    guildId,
    details: { feedId: result.feed.id, roleId },
  });
  emitGuildEvent(guildId, { type: 'feed.changed', payload: { guildId, feedId: result.feed.id } });
  res.json({ ok: true, mentionRoles: result.mentionRoles });
});

feedsRouter.delete('/:id/roles/:roleId', requireGuildPermission('feeds.manage'), async (req, res) => {
  const { guildId } = req.guildScope!;
  const roleId = String(req.params.roleId);
  const result = await removeCanonicalFeedRole(guildId, String(req.params.id), roleId);
  if (!result.ok) { respondFailure(res, result); return; }

  logAuditDb('FEED_ROLE_REMOVED', 'FEED', {
    actorUserId: req.auth!.userId,
    guildId,
    details: { feedId: result.feed.id, roleId },
  });
  emitGuildEvent(guildId, { type: 'feed.changed', payload: { guildId, feedId: result.feed.id } });
  res.json({ ok: true, mentionRoles: result.mentionRoles });
});

feedsRouter.get('/:id/webhook', requireGuildPermission('feeds.manage'), async (req, res) => {
  const { guildId } = req.guildScope!;
  const result = await getCanonicalFeedWebhook(guildId, String(req.params.id));
  if (!result.ok) { respondFailure(res, result); return; }
  res.json({ webhookUrl: result.webhookUrl, secret: result.secret, hmacHeader: result.hmacHeader });
});

feedsRouter.post('/:id/webhook/rotate', requireGuildPermission('feeds.manage'), async (req, res) => {
  const { guildId } = req.guildScope!;
  const result = await rotateCanonicalFeedWebhook(guildId, String(req.params.id));
  if (!result.ok) { respondFailure(res, result); return; }

  logAuditDb('FEED_WEBHOOK_SECRET_ROTATED', 'FEED', {
    actorUserId: req.auth!.userId,
    guildId,
    details: { feedId: result.feed.id },
  });
  res.json({ ok: true, secret: result.secret });
});
