/**
 * Killfeed-Routen — pro Guild + Slot eigene Configs.
 *
 *   GET    /                   Liste aller KillfeedConfigs (slot-gefiltert)
 *   POST   /                   neue Config anlegen
 *   PATCH  /:id                Config updaten (Toggles, Categories, Channel)
 *   DELETE /:id                Config loeschen
 *   GET    /:id/recent         letzte 50 Events
 *
 * Strikte guildId-Scope-Pruefung in jeder Query — siehe ESLint-Rule.
 */

import { Router } from 'express';
import { PermissionFlagsBits } from 'discord.js';
import { requireGuildPermission } from '../../middleware/auth';
import prisma from '../../../database/prisma';
import { logAuditDb } from '../../../utils/logger';
import { emitGuildEvent } from '../../socket/emitter';
import { tryGetDashboardClient } from '../../clientRegistry';
import { validateBotChannelAccess } from '../../../utils/discordChannel';

export const killfeedRouter = Router({ mergeParams: true });

const SNOWFLAKE_RE = /^\d{17,20}$/;
const HEX_RE = /^#?[0-9a-fA-F]{6}$/;
const VALID_CATEGORIES = ['DEATH', 'SUICIDE', 'NPC', 'VEHICLE'] as const;
type Category = typeof VALID_CATEGORIES[number];

interface KillfeedBody {
  channelId?: string;
  isActive?: boolean;
  categories?: string[];
  showShooterCoords?: boolean;
  showVictimCoords?: boolean;
  showWeapon?: boolean;
  showDistance?: boolean;
  embedColor?: string;
}

function validateBody(b: KillfeedBody, partial: boolean):
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: string } {
  const data: Record<string, unknown> = {};

  if (b.channelId !== undefined) {
    if (typeof b.channelId !== 'string' || !SNOWFLAKE_RE.test(b.channelId)) {
      return { ok: false, error: 'channelId muss Discord-Snowflake sein.' };
    }
    data.channelId = b.channelId;
  } else if (!partial) return { ok: false, error: 'channelId fehlt.' };

  if (b.isActive !== undefined) {
    if (typeof b.isActive !== 'boolean') return { ok: false, error: 'isActive muss bool sein.' };
    data.isActive = b.isActive;
  }

  if (b.categories !== undefined) {
    if (!Array.isArray(b.categories)) return { ok: false, error: 'categories muss Array sein.' };
    const dedup = new Set<Category>();
    for (const c of b.categories) {
      if (typeof c !== 'string' || !VALID_CATEGORIES.includes(c as Category)) {
        return { ok: false, error: `Ungueltige Kategorie: ${String(c)}.` };
      }
      dedup.add(c as Category);
    }
    data.categories = Array.from(dedup);
  } else if (!partial) {
    data.categories = ['DEATH', 'SUICIDE', 'NPC', 'VEHICLE'];
  }

  for (const k of ['showShooterCoords', 'showVictimCoords', 'showWeapon', 'showDistance'] as const) {
    if (b[k] !== undefined) {
      if (typeof b[k] !== 'boolean') return { ok: false, error: `${k} muss bool sein.` };
      data[k] = b[k];
    }
  }

  if (b.embedColor !== undefined) {
    if (typeof b.embedColor !== 'string' || !HEX_RE.test(b.embedColor)) {
      return { ok: false, error: 'embedColor muss Hex sein (z.B. #dc2626).' };
    }
    data.embedColor = b.embedColor.startsWith('#') ? b.embedColor : `#${b.embedColor}`;
  }

  if (partial && Object.keys(data).length === 0) {
    return { ok: false, error: 'Keine gueltigen Felder.' };
  }
  return { ok: true, data };
}

async function activeSlotId(guildId: string, slotParam: unknown): Promise<string | null> {
  if (typeof slotParam === 'string' && /^[1-5]$/.test(slotParam)) {
    const c = await prisma.nitradoConnection.findUnique({
      where: { guildId_slot: { guildId, slot: Number(slotParam) } }, select: { id: true },
    });
    return c?.id ?? null;
  }
  const c = await prisma.nitradoConnection.findFirst({
    where: { guildId, status: 'ACTIVE' }, orderBy: { slot: 'asc' }, select: { id: true },
  });
  return c?.id ?? null;
}

async function ensureChannelInGuild(channelId: string, guildId: string): Promise<string | null> {
  const client = tryGetDashboardClient();
  if (!client) return null;
  const v = await validateBotChannelAccess(client, guildId, channelId, [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
  ]);
  return v.ok ? null : v.reason;
}

killfeedRouter.get('/', requireGuildPermission('killfeed.view'), async (req, res) => {
  const scope = req.guildScope!;
  const connId = await activeSlotId(scope.guildId, req.query.slot);
  if (!connId) { res.status(404).json({ error: 'Kein Nitrado-Slot.' }); return; }
  const rows = await prisma.killfeedConfig.findMany({
    where: { guildId: scope.guildId, nitradoConnId: connId },
    orderBy: { createdAt: 'asc' },
  });
  res.json({
    configs: rows.map(r => ({
      id: r.id,
      channelId: r.channelId,
      isActive: r.isActive,
      categories: r.categories,
      showShooterCoords: r.showShooterCoords,
      showVictimCoords: r.showVictimCoords,
      showWeapon: r.showWeapon,
      showDistance: r.showDistance,
      embedColor: r.embedColor,
      lastEventAt: r.lastEventAt?.toISOString() ?? null,
      lastFileName: r.lastFileName,
      lastPolledAt: r.lastPolledAt?.toISOString() ?? null,
      lastErrorMsg: r.lastErrorMsg,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    })),
  });
});

killfeedRouter.post('/', requireGuildPermission('killfeed.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const connId = await activeSlotId(scope.guildId, req.query.slot);
  if (!connId) { res.status(404).json({ error: 'Kein Nitrado-Slot.' }); return; }

  const v = validateBody(req.body as KillfeedBody, false);
  if (!v.ok) { res.status(400).json({ error: v.error }); return; }
  const data = v.data;

  const channelErr = await ensureChannelInGuild(data.channelId as string, scope.guildId);
  if (channelErr) { res.status(400).json({ error: channelErr }); return; }

  try {
    const created = await prisma.killfeedConfig.create({
      data: {
        guildId: scope.guildId,
        nitradoConnId: connId,
        channelId: data.channelId as string,
        isActive: (data.isActive as boolean | undefined) ?? true,
        categories: data.categories as Category[],
        showShooterCoords: (data.showShooterCoords as boolean | undefined) ?? false,
        showVictimCoords: (data.showVictimCoords as boolean | undefined) ?? true,
        showWeapon: (data.showWeapon as boolean | undefined) ?? true,
        showDistance: (data.showDistance as boolean | undefined) ?? true,
        embedColor: (data.embedColor as string | undefined) ?? '#dc2626',
      },
    });
    logAuditDb('KILLFEED_CONFIG_CREATED', 'KILLFEED', {
      actorUserId: scope.actorDiscordId, guildId: scope.guildId,
      details: { configId: created.id, channelId: created.channelId },
    });
    emitGuildEvent(scope.guildId, { type: 'killfeed.changed', payload: { guildId: scope.guildId, configId: created.id } });
    res.status(201).json({ id: created.id });
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes('Unique')) {
      res.status(409).json({ error: 'Killfeed-Config fuer diesen Channel existiert bereits.' });
      return;
    }
    res.status(500).json({ error: 'Konnte Killfeed-Config nicht anlegen.' });
  }
});

killfeedRouter.patch('/:id', requireGuildPermission('killfeed.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const id = String(req.params.id);
  const v = validateBody(req.body as KillfeedBody, true);
  if (!v.ok) { res.status(400).json({ error: v.error }); return; }
  const data = v.data;

  const existing = await prisma.killfeedConfig.findFirst({
    where: { id, guildId: scope.guildId },
  });
  if (!existing) { res.status(404).json({ error: 'Killfeed-Config nicht gefunden.' }); return; }

  if (typeof data.channelId === 'string' && data.channelId !== existing.channelId) {
    const channelErr = await ensureChannelInGuild(data.channelId, scope.guildId);
    if (channelErr) { res.status(400).json({ error: channelErr }); return; }
  }

  try {
    await prisma.killfeedConfig.updateMany({
      where: { id, guildId: scope.guildId },
      data,
    });
    logAuditDb('KILLFEED_CONFIG_UPDATED', 'KILLFEED', {
      actorUserId: scope.actorDiscordId, guildId: scope.guildId,
      details: { configId: id, fields: Object.keys(data) },
    });
    emitGuildEvent(scope.guildId, { type: 'killfeed.changed', payload: { guildId: scope.guildId, configId: id } });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Update fehlgeschlagen.' });
  }
});

killfeedRouter.delete('/:id', requireGuildPermission('killfeed.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const id = String(req.params.id);
  const r = await prisma.killfeedConfig.deleteMany({ where: { id, guildId: scope.guildId } });
  if (r.count === 0) { res.status(404).json({ error: 'Nicht gefunden.' }); return; }
  logAuditDb('KILLFEED_CONFIG_DELETED', 'KILLFEED', {
    actorUserId: scope.actorDiscordId, guildId: scope.guildId,
    details: { configId: id },
  });
  emitGuildEvent(scope.guildId, { type: 'killfeed.changed', payload: { guildId: scope.guildId, configId: id } });
  res.json({ ok: true });
});

killfeedRouter.get('/:id/recent', requireGuildPermission('killfeed.view'), async (req, res) => {
  const scope = req.guildScope!;
  const id = String(req.params.id);
  const cfg = await prisma.killfeedConfig.findFirst({
    where: { id, guildId: scope.guildId },
    select: { nitradoConnId: true },
  });
  if (!cfg) { res.status(404).json({ error: 'Nicht gefunden.' }); return; }

  const events = await prisma.killfeedEvent.findMany({
    where: { guildId: scope.guildId, nitradoConnId: cfg.nitradoConnId },
    orderBy: { occurredAt: 'desc' },
    take: 50,
  });
  res.json({
    events: events.map(e => ({
      id: e.id,
      category: e.category,
      occurredAt: e.occurredAt.toISOString(),
      shooterName: e.shooterName,
      victimName: e.victimName,
      weapon: e.weapon,
      distance: e.distance,
      postedAt: e.postedAt?.toISOString() ?? null,
    })),
  });
});
