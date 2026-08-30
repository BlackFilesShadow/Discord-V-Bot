/**
 * GET  /api/v2/guilds/:guildId/dashboard
 *   -> Aggregierter State: alias5, alle Slots (mit alias+alias5), Permission-Grants-Count.
 *
 * GET  /api/v2/guilds/:guildId/dashboard/server/:slot/settings
 * PATCH /api/v2/guilds/:guildId/dashboard/server/:slot/settings
 *   -> ServerSettings + kanonisches Keep-Online-Flag pro Gameserver.
 */
import { Router } from 'express';
import type { Response } from 'express';
import { requireGuildPermission } from '../../middleware/auth';
import { getOrCreate as getOrCreateLink } from '../../../modules/dashboard/repository';
import { listSlots } from '../../../modules/nitrado/repository';
import { listGrants } from '../../../modules/permissions/repository';
import { asUserDiscordId, effectiveDashboardPermissions } from '../../../types/scope';
import type { GuildScope, NitradoConnId } from '../../../types/scope';
import { hasPermission as scopeHas } from '../../../types/scope';
import prisma from '../../../database/prisma';
import { logAuditDb } from '../../../utils/logger';
import { emitGuildEvent } from '../../socket/emitter';
import { cancelPendingKeepOnlineJobs, type KeepOnlineJobClient } from '../../../modules/nitrado/keepOnlineJobs';
import {
  tryAcquireNitradoConfigMutationLock,
  type HeldNitradoConfigLock,
} from '../../../modules/nitrado/configMutationLock';
import { resolveDashboardGameServer, sendDashboardServerResolutionError } from './serverScope';

export const dashboardRouter = Router({ mergeParams: true });

dashboardRouter.get('/', requireGuildPermission('dashboard.view'), async (req, res) => {
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
    permissions: effectiveDashboardPermissions(scope),
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

async function resolveSlotConn(
  scope: Pick<GuildScope, 'guildId' | 'actorDiscordId'>,
  slotParam: string,
  res: Response,
): Promise<{ id: NitradoConnId; keepOnlineEnabled: boolean } | null> {
  const resolution = await resolveDashboardGameServer(scope.guildId, scope.actorDiscordId, slotParam);
  if (resolution.kind !== 'RESOLVED') {
    sendDashboardServerResolutionError(res, resolution);
    return null;
  }
  const conn = await prisma.nitradoConnection.findFirst({
    where: { id: resolution.nitradoConnId, guildId: scope.guildId },
    select: { id: true, keepOnlineEnabled: true },
  });
  if (!conn) {
    respondKeepOnlineVersionConflict(res);
    return null;
  }
  return { id: resolution.nitradoConnId, keepOnlineEnabled: conn.keepOnlineEnabled };
}

function respondKeepOnlineBusy(res: Response): void {
  res.status(409).json({
    error: 'Nitrado-Connection wird gerade von einem Server-Job verwendet. Bitte Keep-Online erneut setzen.',
    code: 'NITRADO_CONNECTION_BUSY',
  });
}

function respondKeepOnlineVersionConflict(res: Response): void {
  res.status(409).json({
    error: 'Der Gameserver-Slot wurde parallel geaendert. Bitte aktuellen Stand neu laden und Keep-Online erneut setzen.',
    code: 'NITRADO_SLOT_VERSION_CONFLICT',
  });
}

dashboardRouter.get('/server/:slot/settings', requireGuildPermission('whitelist.view'), async (req, res) => {
  const scope = req.guildScope!;
  const conn = await resolveSlotConn(scope, String(req.params.slot), res);
  if (!conn) return;
  const s = await prisma.serverSettings.upsert({
    where: { guildId_nitradoConnId: { guildId: scope.guildId, nitradoConnId: conn.id } },
    create: { guildId: scope.guildId, nitradoConnId: conn.id },
    update: {},
  });
  res.json({
    nitradoConnId: conn.id,
    whitelistActive: s.whitelistActive,
    economyActive: s.economyActive,
    permaOnly: conn.keepOnlineEnabled,
    whitelistChannelId: s.whitelistChannelId,
    whitelistRequestChannelId: s.whitelistRequestChannelId,
  });
});

dashboardRouter.patch('/server/:slot/settings', requireGuildPermission('whitelist.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const slotParam = String(req.params.slot);
  const conn = await resolveSlotConn(scope, slotParam, res);
  if (!conn) return;
  const b = req.body ?? {};
  const data: Record<string, unknown> = {};
  let keepOnlineEnabled = conn.keepOnlineEnabled;

  if (typeof b.whitelistActive === 'boolean') data.whitelistActive = b.whitelistActive;
  if (typeof b.economyActive === 'boolean') {
    if (!scopeHas(scope, 'economy.manage')) {
      res.status(403).json({ error: 'economyActive erfordert economy.manage.' });
      return;
    }
    data.economyActive = b.economyActive;
  }
  if (typeof b.permaOnly === 'boolean') {
    if (!scopeHas(scope, 'nitrado.keep-online')) {
      res.status(403).json({ error: 'Keep-Online erfordert nitrado.keep-online.' });
      return;
    }
    keepOnlineEnabled = b.permaOnly;
  }
  if (b.whitelistChannelId === null || (typeof b.whitelistChannelId === 'string' && /^\d{17,20}$/.test(b.whitelistChannelId))) {
    data.whitelistChannelId = b.whitelistChannelId;
  }
  if (b.whitelistRequestChannelId === null || (typeof b.whitelistRequestChannelId === 'string' && /^\d{17,20}$/.test(b.whitelistRequestChannelId))) {
    data.whitelistRequestChannelId = b.whitelistRequestChannelId;
  }
  if (Object.keys(data).length === 0 && typeof b.permaOnly !== 'boolean') {
    res.status(400).json({ error: 'Keine gueltigen Felder.' });
    return;
  }

  const persistSettings = async () => prisma.$transaction(async tx => {
    const settings = await tx.serverSettings.upsert({
      where: { guildId_nitradoConnId: { guildId: scope.guildId, nitradoConnId: conn.id } },
      create: { guildId: scope.guildId, nitradoConnId: conn.id, ...data },
      update: data,
    });

    // ServerSettings.economyActive ist die kanonische Aktivierung. Das alte
    // EconomyConfig.enabled bleibt nur als Runtime-/Migrationskompatibilitaet
    // synchron, damit bestehende Scheduler und alte Clients nicht abweichen.
    if (typeof b.economyActive === 'boolean') {
      await tx.economyConfig.upsert({
        where: { guildServer: { guildId: scope.guildId, nitradoConnId: conn.id } },
        create: { guildId: scope.guildId, nitradoConnId: conn.id, enabled: b.economyActive },
        update: { enabled: b.economyActive },
      });
      await tx.economySlotConfig.upsert({
        where: { guildId_nitradoConnId: { guildId: scope.guildId, nitradoConnId: conn.id } },
        create: { guildId: scope.guildId, nitradoConnId: conn.id, enabled: b.economyActive },
        update: { enabled: b.economyActive },
      });
    }

    if (typeof b.permaOnly === 'boolean') {
      await tx.nitradoConnection.updateMany({
        where: { id: conn.id, guildId: scope.guildId },
        data: { keepOnlineEnabled },
      });
      if (!keepOnlineEnabled) {
        await cancelPendingKeepOnlineJobs(
          tx as unknown as KeepOnlineJobClient,
          { guildId: scope.guildId, nitradoConnId: conn.id },
        );
      }
    }
    return settings;
  });

  let keepOnlineLock: HeldNitradoConfigLock | null = null;
  if (typeof b.permaOnly === 'boolean') {
    keepOnlineLock = await tryAcquireNitradoConfigMutationLock(conn.id);
    if (!keepOnlineLock) {
      respondKeepOnlineBusy(res);
      return;
    }
  }

  let s: Awaited<ReturnType<typeof persistSettings>>;
  try {
    if (keepOnlineLock) {
      // Zwischen erster Slot-Aufloesung und gewonnenem Lock koennen Token/Service/
      // Delete-Aenderungen bereits abgeschlossen worden sein. Unter dem Lock den
      // kanonischen Scope erneut aufloesen und Delete->Recreate desselben Slot-
      // Indexes fail-closed erkennen, bevor Keep-Online committed wird.
      const freshConn = await resolveSlotConn(scope, slotParam, res);
      if (!freshConn) return;
      if (freshConn.id !== conn.id) {
        respondKeepOnlineVersionConflict(res);
        return;
      }
    }

    // Der Connection-Lock bleibt ueber Keep-Online-Write + PENDING-Job-Cancel
    // gehalten. Ein bereits laufender Worker besitzt denselben Lock und zwingt
    // diesen Request deshalb vorher auf 409; ein wartender Worker liest nach
    // Release den committed kanonischen Zustand neu.
    s = await persistSettings();
  } finally {
    await keepOnlineLock?.release();
  }

  logAuditDb('SERVER_SETTINGS_UPDATED', 'SERVER_SETTINGS', {
    actorUserId: req.auth!.userId,
    guildId: scope.guildId,
    details: {
      slotId: conn.id,
      fields: [...Object.keys(data), ...(typeof b.permaOnly === 'boolean' ? ['keepOnlineEnabled'] : [])],
    },
  });
  emitGuildEvent(scope.guildId, { type: 'settings.changed', payload: { guildId: scope.guildId, slotId: conn.id } });
  res.json({
    nitradoConnId: conn.id,
    whitelistActive: s.whitelistActive,
    economyActive: s.economyActive,
    permaOnly: keepOnlineEnabled,
    whitelistChannelId: s.whitelistChannelId,
    whitelistRequestChannelId: s.whitelistRequestChannelId,
  });
});
