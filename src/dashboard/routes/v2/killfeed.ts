/**
 * Gameplay-Feed-Routen. Der bestehende /killfeed-Pfad bleibt aus
 * Rueckwaertskompatibilitaet erhalten; `?kind=DEATH|BUILD|PLAYER_LIST`
 * waehlt den Feed. Ohne kind gilt DEATH.
 */

import { Router } from 'express';
import { PermissionFlagsBits } from 'discord.js';
import { GameplayFeedKind } from '@prisma/client';
import { requireGuildPermission } from '../../middleware/auth';
import prisma from '../../../database/prisma';
import { logAuditDb } from '../../../utils/logger';
import { emitGuildEvent } from '../../socket/emitter';
import { tryGetDashboardClient } from '../../clientRegistry';
import { validateBotChannelAccess } from '../../../utils/discordChannel';
import { resolveDashboardGameServer, sendDashboardServerResolutionError } from './serverScope';
import {
  BUILD_EVENT_TYPES,
  BUILD_CATEGORIES,
  DEATH_EVENT_TYPES,
  DEATH_CATEGORIES,
  categoryForEvent,
  type GameplayFeedKindValue,
} from '../../../modules/gameplayFeeds/types';

export const killfeedRouter = Router({ mergeParams: true });

const SNOWFLAKE_RE = /^\d{17,20}$/;
const HEX_RE = /^#?[0-9a-fA-F]{6}$/;

interface FeedBody {
  channelId?: string;
  isActive?: boolean;
  categories?: string[];
  showActorCoords?: boolean;
  showTargetCoords?: boolean;
  showTool?: boolean;
  showDistance?: boolean;
  embedColor?: string;
  // Legacy-Aliase fuer bestehende Dashboard-Clients.
  showShooterCoords?: boolean;
  showVictimCoords?: boolean;
  showWeapon?: boolean;
}

function readKind(raw: unknown): GameplayFeedKindValue | null {
  const value = String(raw ?? 'DEATH').trim().toUpperCase();
  return value === 'DEATH' || value === 'BUILD' || value === 'PLAYER_LIST' ? value : null;
}

function allowedCategories(kind: GameplayFeedKindValue): readonly string[] {
  if (kind === 'PLAYER_LIST') return [];
  return kind === 'DEATH' ? DEATH_CATEGORIES : BUILD_CATEGORIES;
}

function defaultCategories(kind: GameplayFeedKindValue): string[] {
  return [...allowedCategories(kind)];
}

function validateBody(
  body: FeedBody,
  kind: GameplayFeedKindValue,
  partial: boolean,
): { ok: true; data: Record<string, unknown> } | { ok: false; error: string } {
  const data: Record<string, unknown> = {};

  if (body.channelId !== undefined) {
    if (typeof body.channelId !== 'string' || !SNOWFLAKE_RE.test(body.channelId)) {
      return { ok: false, error: 'channelId muss Discord-Snowflake sein.' };
    }
    data.channelId = body.channelId;
  } else if (!partial) {
    return { ok: false, error: 'channelId fehlt.' };
  }

  if (body.isActive !== undefined) {
    if (typeof body.isActive !== 'boolean') return { ok: false, error: 'isActive muss bool sein.' };
    data.isActive = body.isActive;
  }

  if (body.categories !== undefined) {
    if (!Array.isArray(body.categories)) return { ok: false, error: 'categories muss Array sein.' };
    const allowed = allowedCategories(kind);
    const categories = Array.from(new Set(body.categories.map(value => String(value).trim().toUpperCase())));
    if (categories.length === 0 && kind !== 'PLAYER_LIST') return { ok: false, error: 'Mindestens eine Kategorie ist erforderlich.' };
    for (const category of categories) {
      if (!allowed.includes(category)) return { ok: false, error: `Ungueltige ${kind}-Kategorie: ${category}.` };
    }
    data.categories = categories;
  } else if (!partial) {
    data.categories = defaultCategories(kind);
  }

  const actorCoords = body.showActorCoords ?? body.showVictimCoords;
  const targetCoords = body.showTargetCoords ?? body.showShooterCoords;
  const showTool = body.showTool ?? body.showWeapon;
  for (const [key, value] of [
    ['showActorCoords', actorCoords],
    ['showTargetCoords', targetCoords],
    ['showTool', showTool],
    ['showDistance', body.showDistance],
  ] as const) {
    if (value === undefined) continue;
    if (typeof value !== 'boolean') return { ok: false, error: `${key} muss bool sein.` };
    data[key] = value;
  }

  if (body.embedColor !== undefined) {
    if (typeof body.embedColor !== 'string' || !HEX_RE.test(body.embedColor)) {
      return { ok: false, error: 'embedColor muss Hex sein (z.B. #dc2626).' };
    }
    data.embedColor = body.embedColor.startsWith('#') ? body.embedColor : `#${body.embedColor}`;
  }

  if (partial && Object.keys(data).length === 0) return { ok: false, error: 'Keine gueltigen Felder.' };
  return { ok: true, data };
}

async function ensureChannelInGuild(channelId: string, guildId: string): Promise<string | null> {
  const client = tryGetDashboardClient();
  if (!client) return 'Discord-Client ist derzeit nicht verfuegbar.';
  const result = await validateBotChannelAccess(client, guildId, channelId, [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
  ]);
  return result.ok ? null : result.reason;
}

function responseConfig(row: {
  id: string;
  kind: GameplayFeedKind;
  nitradoConnId: string;
  channelId: string;
  isActive: boolean;
  categories: string[];
  showActorCoords: boolean;
  showTargetCoords: boolean;
  showTool: boolean;
  showDistance: boolean;
  embedColor: string;
  lastEventAt: Date | null;
  lastPolledAt: Date | null;
  lastErrorMsg: string | null;
  nextDeliveryAt: Date;
  lastMessageId: string | null;
  lastPlayerCount: number | null;
  lastPlayerListAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    kind: row.kind,
    nitradoConnId: row.nitradoConnId,
    channelId: row.channelId,
    isActive: row.isActive,
    categories: row.categories,
    showActorCoords: row.showActorCoords,
    showTargetCoords: row.showTargetCoords,
    showTool: row.showTool,
    showDistance: row.showDistance,
    // Legacy-Aliase.
    showVictimCoords: row.showActorCoords,
    showShooterCoords: row.showTargetCoords,
    showWeapon: row.showTool,
    embedColor: row.embedColor,
    lastEventAt: row.lastEventAt?.toISOString() ?? null,
    lastPolledAt: row.lastPolledAt?.toISOString() ?? null,
    lastErrorMsg: row.lastErrorMsg,
    nextDeliveryAt: row.nextDeliveryAt.toISOString(),
    lastMessageId: row.lastMessageId,
    lastPlayerCount: row.lastPlayerCount,
    lastPlayerListAt: row.lastPlayerListAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

killfeedRouter.get('/', requireGuildPermission('killfeed.view'), async (req, res) => {
  const scope = req.guildScope!;
  const kind = readKind(req.query.kind);
  if (!kind) { res.status(400).json({ error: 'kind muss DEATH, BUILD oder PLAYER_LIST sein.' }); return; }
  const resolution = await resolveDashboardGameServer(scope.guildId, scope.actorDiscordId, req.query.slot);
  if (resolution.kind !== 'RESOLVED') { sendDashboardServerResolutionError(res, resolution); return; }

  const rows = await prisma.gameplayFeedConfig.findMany({
    where: {
      guildId: scope.guildId,
      nitradoConnId: resolution.nitradoConnId,
      kind: kind as GameplayFeedKind,
    },
    orderBy: { createdAt: 'asc' },
  });
  const configs = await Promise.all(rows.map(async row => {
    const [statusGroups, oldestOpen, lastSuccess] = await Promise.all([
      prisma.gameplayFeedDelivery.groupBy({
        by: ['status'],
        where: { configId: row.id, guildId: scope.guildId, nitradoConnId: resolution.nitradoConnId },
        _count: { _all: true },
      }),
      prisma.gameplayFeedDelivery.findFirst({
        where: {
          configId: row.id,
          guildId: scope.guildId,
          nitradoConnId: resolution.nitradoConnId,
          status: { in: ['PENDING', 'SENDING', 'RETRY'] },
        },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
      prisma.gameplayFeedDelivery.findFirst({
        where: {
          configId: row.id,
          guildId: scope.guildId,
          nitradoConnId: resolution.nitradoConnId,
          status: 'SENT',
        },
        orderBy: { sentAt: 'desc' },
        select: { sentAt: true },
      }),
    ]);
    const counts = new Map(statusGroups.map(group => [group.status, group._count._all]));
    return {
      ...responseConfig(row),
      openDeliveryCount: (counts.get('PENDING') ?? 0) + (counts.get('SENDING') ?? 0) + (counts.get('RETRY') ?? 0),
      retryDeliveryCount: counts.get('RETRY') ?? 0,
      failedDeliveryCount: counts.get('FAILED') ?? 0,
      oldestOpenAt: oldestOpen?.createdAt.toISOString() ?? null,
      lastSuccessAt: lastSuccess?.sentAt?.toISOString() ?? null,
    };
  }));
  res.json({ kind, configs });
});

killfeedRouter.post('/', requireGuildPermission('killfeed.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const kind = readKind(req.query.kind);
  if (!kind) { res.status(400).json({ error: 'kind muss DEATH, BUILD oder PLAYER_LIST sein.' }); return; }
  const resolution = await resolveDashboardGameServer(scope.guildId, scope.actorDiscordId, req.query.slot);
  if (resolution.kind !== 'RESOLVED') { sendDashboardServerResolutionError(res, resolution); return; }

  const parsed = validateBody(req.body as FeedBody, kind, false);
  if (!parsed.ok) { res.status(400).json({ error: parsed.error }); return; }
  const data = parsed.data;
  const channelError = await ensureChannelInGuild(data.channelId as string, scope.guildId);
  if (channelError) { res.status(400).json({ error: channelError }); return; }

  try {
    const created = await prisma.gameplayFeedConfig.create({
      data: {
        guildId: scope.guildId,
        nitradoConnId: resolution.nitradoConnId,
        kind: kind as GameplayFeedKind,
        channelId: data.channelId as string,
        isActive: (data.isActive as boolean | undefined) ?? true,
        categories: data.categories as string[],
        showActorCoords: (data.showActorCoords as boolean | undefined) ?? true,
        showTargetCoords: (data.showTargetCoords as boolean | undefined) ?? false,
        showTool: (data.showTool as boolean | undefined) ?? true,
        showDistance: kind === 'DEATH' ? ((data.showDistance as boolean | undefined) ?? true) : false,
        embedColor: (data.embedColor as string | undefined) ?? (kind === 'BUILD' ? '#eab308' : kind === 'PLAYER_LIST' ? '#2563eb' : '#dc2626'),
        // Neue Configs starten am Jetzt-Punkt und replayen keinen historischen ADM-Backlog.
        cursorCreatedAt: new Date(),
        cursorEventId: '',
      },
    });
    logAuditDb('GAMEPLAY_FEED_CREATED', 'KILLFEED', {
      actorUserId: req.auth!.userId,
      guildId: scope.guildId,
      details: { configId: created.id, kind, channelId: created.channelId, nitradoConnId: resolution.nitradoConnId },
    });
    emitGuildEvent(scope.guildId, { type: 'killfeed.changed', payload: { guildId: scope.guildId, configId: created.id, kind } });
    res.status(201).json({ id: created.id, kind });
  } catch (error) {
    if ((error as { code?: string }).code === 'P2002') {
      res.status(409).json({ error: 'Feed fuer diesen Server, Typ und Channel existiert bereits.' });
      return;
    }
    res.status(500).json({ error: 'Feed konnte nicht angelegt werden.' });
  }
});

killfeedRouter.patch('/:id', requireGuildPermission('killfeed.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const kind = readKind(req.query.kind);
  if (!kind) { res.status(400).json({ error: 'kind muss DEATH, BUILD oder PLAYER_LIST sein.' }); return; }
  const resolution = await resolveDashboardGameServer(scope.guildId, scope.actorDiscordId, req.query.slot);
  if (resolution.kind !== 'RESOLVED') { sendDashboardServerResolutionError(res, resolution); return; }
  const id = String(req.params.id);
  const parsed = validateBody(req.body as FeedBody, kind, true);
  if (!parsed.ok) { res.status(400).json({ error: parsed.error }); return; }

  const existing = await prisma.gameplayFeedConfig.findFirst({
    where: { id, guildId: scope.guildId, nitradoConnId: resolution.nitradoConnId, kind: kind as GameplayFeedKind },
  });
  if (!existing) { res.status(404).json({ error: 'Feed-Config nicht gefunden.' }); return; }

  if (typeof parsed.data.channelId === 'string' && parsed.data.channelId !== existing.channelId) {
    const channelError = await ensureChannelInGuild(parsed.data.channelId, scope.guildId);
    if (channelError) { res.status(400).json({ error: channelError }); return; }
  }

  try {
    await prisma.$transaction(async tx => {
      const locked = await tx.$queryRaw<Array<{ id: string; isActive: boolean }>>`
        SELECT "id", "isActive"
          FROM "GameplayFeedConfig"
         WHERE "id"=${id}
           AND "guildId"=${scope.guildId}
           AND "nitradoConnId"=${resolution.nitradoConnId}
           AND "kind"=${kind}::"GameplayFeedKind"
         FOR UPDATE`;
      if (!locked[0]) throw new Error('CONFIG_SCOPE_LOST');

      const updateData = { ...parsed.data };
      if (parsed.data.channelId && parsed.data.channelId !== existing.channelId) {
        updateData.lastMessageId = null;
        updateData.lastStateHash = null;
      }
      if (kind === 'PLAYER_LIST' && parsed.data.showActorCoords !== undefined) {
        updateData.lastStateHash = null;
      }
      if (locked[0].isActive === false && parsed.data.isActive === true && kind !== 'PLAYER_LIST') {
        const watermark = await tx.admEvent.findFirst({
          where: {
            guildId: scope.guildId,
            nitradoConnId: resolution.nitradoConnId,
            eventType: { in: kind === 'DEATH' ? [...DEATH_EVENT_TYPES] : [...BUILD_EVENT_TYPES] },
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: { createdAt: true, id: true },
        });
        updateData.cursorCreatedAt = watermark?.createdAt ?? new Date();
        updateData.cursorEventId = watermark?.id ?? '';
      }
      if (locked[0].isActive === false && parsed.data.isActive === true && kind === 'PLAYER_LIST') {
        updateData.lastStateHash = null;
      }
      await tx.gameplayFeedConfig.updateMany({
        where: { id, guildId: scope.guildId, nitradoConnId: resolution.nitradoConnId, kind: kind as GameplayFeedKind },
        data: updateData,
      });
    });
    logAuditDb('GAMEPLAY_FEED_UPDATED', 'KILLFEED', {
      actorUserId: req.auth!.userId,
      guildId: scope.guildId,
      details: { configId: id, kind, nitradoConnId: resolution.nitradoConnId, fields: Object.keys(parsed.data) },
    });
    emitGuildEvent(scope.guildId, { type: 'killfeed.changed', payload: { guildId: scope.guildId, configId: id, kind } });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Update fehlgeschlagen.' });
  }
});

killfeedRouter.delete('/:id', requireGuildPermission('killfeed.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const kind = readKind(req.query.kind);
  if (!kind) { res.status(400).json({ error: 'kind muss DEATH, BUILD oder PLAYER_LIST sein.' }); return; }
  const resolution = await resolveDashboardGameServer(scope.guildId, scope.actorDiscordId, req.query.slot);
  if (resolution.kind !== 'RESOLVED') { sendDashboardServerResolutionError(res, resolution); return; }
  const id = String(req.params.id);
  const result = await prisma.gameplayFeedConfig.deleteMany({
    where: { id, guildId: scope.guildId, nitradoConnId: resolution.nitradoConnId, kind: kind as GameplayFeedKind },
  });
  if (result.count === 0) { res.status(404).json({ error: 'Nicht gefunden.' }); return; }
  logAuditDb('GAMEPLAY_FEED_DELETED', 'KILLFEED', {
    actorUserId: req.auth!.userId,
    guildId: scope.guildId,
    details: { configId: id, kind, nitradoConnId: resolution.nitradoConnId },
  });
  emitGuildEvent(scope.guildId, { type: 'killfeed.changed', payload: { guildId: scope.guildId, configId: id, kind } });
  res.json({ ok: true });
});

killfeedRouter.get('/:id/recent', requireGuildPermission('killfeed.view'), async (req, res) => {
  const scope = req.guildScope!;
  const resolution = await resolveDashboardGameServer(scope.guildId, scope.actorDiscordId, req.query.slot);
  if (resolution.kind !== 'RESOLVED') { sendDashboardServerResolutionError(res, resolution); return; }
  const id = String(req.params.id);
  const config = await prisma.gameplayFeedConfig.findFirst({
    where: { id, guildId: scope.guildId, nitradoConnId: resolution.nitradoConnId },
  });
  if (!config) { res.status(404).json({ error: 'Nicht gefunden.' }); return; }

  const deliveries = await prisma.gameplayFeedDelivery.findMany({
    where: {
      configId: id,
      guildId: scope.guildId,
      nitradoConnId: resolution.nitradoConnId,
      status: 'SENT',
    },
    orderBy: { sentAt: 'desc' },
    take: 50,
    select: { admEventId: true, messageId: true, sentAt: true },
  });
  const eventIds = deliveries.map(delivery => delivery.admEventId);
  const events = eventIds.length === 0 ? [] : await prisma.admEvent.findMany({
    where: { id: { in: eventIds }, guildId: scope.guildId, nitradoConnId: resolution.nitradoConnId },
  });
  const byId = new Map(events.map(event => [event.id, event]));

  res.json({
    kind: config.kind,
    events: deliveries.flatMap(delivery => {
      const event = byId.get(delivery.admEventId);
      if (!event) return [];
      return [{
        id: event.id,
        category: categoryForEvent(event.eventType),
        eventType: event.eventType,
        occurredAt: event.occurredAt?.toISOString() ?? null,
        actorName: event.actorName,
        targetName: event.targetName,
        objectType: event.objectType,
        toolOrWeapon: event.toolOrWeapon,
        distanceMeters: event.distanceMeters,
        actorPosition: event.actorPosition,
        targetPosition: event.targetPosition,
        messageId: delivery.messageId,
        sentAt: delivery.sentAt?.toISOString() ?? null,
      }];
    }),
  });
});
