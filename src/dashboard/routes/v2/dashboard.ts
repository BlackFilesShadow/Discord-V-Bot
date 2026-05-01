/**
 * GET  /api/v2/guilds/:guildId/dashboard
 *   -> Aggregierter State: alias5, alle Slots (mit alias+alias5), Permission-Grants-Count.
 *
 * GET  /api/v2/guilds/:guildId/dashboard/server/:slot/settings
 * PATCH /api/v2/guilds/:guildId/dashboard/server/:slot/settings
 *   -> ServerSettings (whitelistActive, economyActive, permaOnly) pro Slot.
 */
import { Router } from 'express';
import { requireGuildPermission } from '../../middleware/auth';
import { getOrCreate as getOrCreateLink } from '../../../modules/dashboard/repository';
import { listSlots } from '../../../modules/nitrado/repository';
import { listGrants } from '../../../modules/permissions/repository';
import { asUserDiscordId } from '../../../types/scope';
import prisma from '../../../database/prisma';
import { logAuditDb } from '../../../utils/logger';
import { emitGuildEvent } from '../../socket/emitter';

export const dashboardRouter = Router({ mergeParams: true });

// Lese-Recht: irgendeine view-Permission reicht; aber Owner-Bypass ist
// eingebaut. Wir nutzen 'whitelist.view' als billigste Standard-Permission;
// wer das nicht hat, hat sowieso nichts auf dem Dashboard zu suchen.
dashboardRouter.get('/', requireGuildPermission('whitelist.view'), async (req, res) => {
  const scope = req.guildScope!;
  const link = await getOrCreateLink(scope.guildId, asUserDiscordId(scope.actorDiscordId));
  const [slots, grants] = await Promise.all([
    listSlots(scope.guildId),
    listGrants(scope.guildId),
  ]);
  res.json({
    guildId: scope.guildId,
    alias5: link.alias5,
    isOwner: scope.isOwner,
    permissions: Array.from(scope.permissions),
    slots: slots.map(s => ({
      id: s.id,
      slot: s.slot,
      alias: s.alias,
      alias5: s.alias5,
      status: s.status,
      nitradoServerId: s.nitradoServerId,
    })),
    grantsCount: grants.length,
  });
});

// --- Server-Settings pro Slot -------------------------------------------------

async function resolveSlotConn(guildId: string, slotParam: string): Promise<{ id: string } | null> {
  if (!/^[1-5]$/.test(slotParam)) return null;
  return prisma.nitradoConnection.findUnique({
    where: { guildId_slot: { guildId, slot: Number(slotParam) } },
    select: { id: true },
  });
}

dashboardRouter.get('/server/:slot/settings', requireGuildPermission('whitelist.view'), async (req, res) => {
  const scope = req.guildScope!;
  const conn = await resolveSlotConn(scope.guildId, String(req.params.slot));
  if (!conn) { res.status(404).json({ error: 'Slot nicht gefunden.' }); return; }
  const s = await prisma.serverSettings.upsert({
    where: { guildId_nitradoConnId: { guildId: scope.guildId, nitradoConnId: conn.id } },
    create: { guildId: scope.guildId, nitradoConnId: conn.id },
    update: {},
  });
  res.json({
    whitelistActive: s.whitelistActive,
    economyActive: s.economyActive,
    permaOnly: s.permaOnly,
    whitelistChannelId: s.whitelistChannelId,
    whitelistRequestChannelId: s.whitelistRequestChannelId,
  });
});

dashboardRouter.patch('/server/:slot/settings', requireGuildPermission('whitelist.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const conn = await resolveSlotConn(scope.guildId, String(req.params.slot));
  if (!conn) { res.status(404).json({ error: 'Slot nicht gefunden.' }); return; }
  const b = req.body ?? {};
  const data: Record<string, unknown> = {};
  if (typeof b.whitelistActive === 'boolean') data.whitelistActive = b.whitelistActive;
  if (typeof b.economyActive === 'boolean') data.economyActive = b.economyActive;
  if (typeof b.permaOnly === 'boolean') data.permaOnly = b.permaOnly;
  if (b.whitelistChannelId === null || (typeof b.whitelistChannelId === 'string' && /^\d{17,20}$/.test(b.whitelistChannelId))) {
    data.whitelistChannelId = b.whitelistChannelId;
  }
  if (b.whitelistRequestChannelId === null || (typeof b.whitelistRequestChannelId === 'string' && /^\d{17,20}$/.test(b.whitelistRequestChannelId))) {
    data.whitelistRequestChannelId = b.whitelistRequestChannelId;
  }
  if (Object.keys(data).length === 0) { res.status(400).json({ error: 'Keine gueltigen Felder.' }); return; }

  const s = await prisma.serverSettings.upsert({
    where: { guildId_nitradoConnId: { guildId: scope.guildId, nitradoConnId: conn.id } },
    create: { guildId: scope.guildId, nitradoConnId: conn.id, ...data },
    update: data,
  });
  logAuditDb('SERVER_SETTINGS_UPDATED', 'SERVER_SETTINGS', { actorUserId: req.auth!.userId, guildId: scope.guildId, details: { slotId: conn.id, fields: Object.keys(data) } });
  emitGuildEvent(scope.guildId, { type: 'settings.changed', payload: { guildId: scope.guildId, slotId: conn.id } });
  res.json({
    whitelistActive: s.whitelistActive,
    economyActive: s.economyActive,
    permaOnly: s.permaOnly,
    whitelistChannelId: s.whitelistChannelId,
    whitelistRequestChannelId: s.whitelistRequestChannelId,
  });
});
