import { Router } from 'express';
import type { Response } from 'express';
import prisma from '../../../database/prisma';
import { config } from '../../../config';
import { decrypt } from '../../../utils/security';
import { logAuditDb, logger } from '../../../utils/logger';
import { emitGuildEvent } from '../../socket/emitter';
import { requireGuildPermission } from '../../middleware/auth';
import { ensureNitradoWriteAllowed } from '../../middleware/nitradoWriteGuard';
import { NitradoClient } from '../../../modules/nitrado/nitradoClient';
import {
  isAdmBindingFenceError,
  readCurrentAdmBinding,
  withFreshAdmBinding,
} from '../../../modules/nitrado/adm/bindingFence';
import {
  enqueueWhitelistAdd,
  type WhitelistOutboxClient,
} from '../../../modules/whitelist/whitelistOutbox';
import {
  enqueueServerBanAdd,
  type BanOutboxClient,
} from '../../../modules/bans/banOutbox';
import { hashBanIdentifier, matchesBanIdentifier } from '../../../modules/bans/banTarget';
import { resolveDashboardGameServer, sendDashboardServerResolutionError } from './serverScope';
import type { GuildScope, NitradoConnId } from '../../../types/scope';

export const nitradoDriftRouter = Router({ mergeParams: true });

type DriftDecision = 'ACCEPT_NITRADO' | 'RESTORE_VBOT';

function norm(value: string): string {
  return value.trim().toLocaleLowerCase('en-US');
}

function parseDecision(value: unknown): DriftDecision | null {
  return value === 'ACCEPT_NITRADO' || value === 'RESTORE_VBOT' ? value : null;
}

function validName(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 128 && !/[\r\n\t]/.test(value);
}

async function activeSlotId(scope: Pick<GuildScope, 'guildId' | 'actorDiscordId'>, slotParam: unknown, res: Response): Promise<NitradoConnId | null> {
  const resolution = await resolveDashboardGameServer(scope.guildId, scope.actorDiscordId, slotParam);
  if (resolution.kind !== 'RESOLVED') {
    sendDashboardServerResolutionError(res, resolution);
    return null;
  }
  return resolution.nitradoConnId;
}

async function readBinding(scope: Pick<GuildScope, 'guildId' | 'actorDiscordId'>, slotParam: unknown, res: Response) {
  const connId = await activeSlotId(scope, slotParam, res);
  if (!connId) return null;
  const binding = await readCurrentAdmBinding({ id: connId, guildId: scope.guildId });
  if (!binding) {
    res.status(409).json({ error: 'Nitrado-Verbindung ist nicht ACTIVE oder besitzt keine Service-ID.' });
    return null;
  }
  return { connId, binding };
}

function safeDecryptIdentifier(identifierEnc: string, identityHash: string): string | null {
  try {
    const identifier = decrypt(identifierEnc, config.security.encryptionKey).trim();
    if (!identifier) return null;
    return matchesBanIdentifier(identifier, identityHash, config.security.encryptionKey) ? identifier : null;
  } catch {
    return null;
  }
}

nitradoDriftRouter.get('/whitelist', requireGuildPermission('whitelist.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const resolved = await readBinding(scope, req.query.slot, res);
  if (!resolved) return;
  const { connId, binding } = resolved;

  let remoteNames: string[];
  try {
    const token = decrypt(binding.encryptedToken, config.security.encryptionKey);
    remoteNames = (await new NitradoClient(token).getWhitelist(binding.nitradoServerId)).map(row => row.identifier);
    await withFreshAdmBinding(binding, async () => undefined);
  } catch (error) {
    if (isAdmBindingFenceError(error)) {
      res.status(409).json({ error: 'Nitrado-Zuordnung hat sich waehrend der Drift-Pruefung geaendert. Bitte erneut laden.' });
      return;
    }
    logger.warn(`Whitelist-Drift-Read fehlgeschlagen fuer ${connId}: ${(error as Error).message}`);
    res.status(502).json({ error: 'Whitelist konnte nicht frisch von Nitrado gelesen werden.' });
    return;
  }

  const remote = new Set(remoteNames.map(norm));
  const local = await prisma.whitelistEntry.findMany({
    where: { guildId: scope.guildId, nitradoConnId: connId, syncState: 'SYNCED' },
    select: { gameId: true, source: true, approvedAt: true, lastSyncedAt: true },
    orderBy: [{ approvedAt: 'desc' }, { gameId: 'asc' }],
    take: 1000,
  });

  const items = local
    .filter(row => !remote.has(norm(row.gameId)))
    .map(row => ({
      kind: 'WHITELIST' as const,
      gameId: row.gameId,
      source: row.source,
      approvedAt: row.approvedAt,
      lastConfirmedRemoteAt: row.lastSyncedAt,
      state: 'REMOTE_MISSING' as const,
      canRestore: true,
    }));

  res.json({ observedAt: new Date().toISOString(), items });
});

nitradoDriftRouter.post('/whitelist/resolve', requireGuildPermission('whitelist.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const decision = parseDecision(req.body?.decision);
  const gameId = validName(req.body?.gameId) ? req.body.gameId.trim() : '';
  if (!decision || !gameId) {
    res.status(400).json({ error: 'gameId und decision (ACCEPT_NITRADO|RESTORE_VBOT) sind erforderlich.' });
    return;
  }
  if (decision === 'RESTORE_VBOT' && !ensureNitradoWriteAllowed(req, res, { action: 'NITRADO_WHITELIST_DRIFT_RESTORE', danger: false })) return;

  const resolved = await readBinding(scope, req.query.slot, res);
  if (!resolved) return;
  const { connId, binding } = resolved;

  let remoteNames: string[];
  try {
    const token = decrypt(binding.encryptedToken, config.security.encryptionKey);
    remoteNames = (await new NitradoClient(token).getWhitelist(binding.nitradoServerId)).map(row => row.identifier);
  } catch (error) {
    logger.warn(`Whitelist-Drift-Resolve-Read fehlgeschlagen fuer ${connId}: ${(error as Error).message}`);
    res.status(502).json({ error: 'Whitelist konnte nicht frisch von Nitrado gelesen werden.' });
    return;
  }
  if (remoteNames.some(name => norm(name) === norm(gameId))) {
    res.status(409).json({ error: 'Die Abweichung besteht nicht mehr: Der Name ist wieder auf Nitrado vorhanden.' });
    return;
  }

  try {
    const result = await withFreshAdmBinding(binding, () => prisma.$transaction(async tx => {
      const row = await tx.whitelistEntry.findFirst({
        where: { guildId: scope.guildId, nitradoConnId: connId, gameId, syncState: 'SYNCED' },
        select: { id: true },
      });
      if (!row) return { resolved: false, queued: false };

      if (decision === 'ACCEPT_NITRADO') {
        await tx.whitelistEntry.deleteMany({
          where: { id: row.id, guildId: scope.guildId, nitradoConnId: connId, syncState: 'SYNCED' },
        });
        await tx.whitelistRequest.updateMany({
          where: {
            guildId: scope.guildId,
            nitradoConnId: connId,
            gameId,
            status: { in: ['PENDING', 'APPROVED'] },
          },
          data: { status: 'CANCELLED' },
        });
        return { resolved: true, queued: false };
      }

      await tx.whitelistEntry.updateMany({
        where: { id: row.id, guildId: scope.guildId, nitradoConnId: connId, syncState: 'SYNCED' },
        data: { syncState: 'LOCAL_ONLY', lastSyncedAt: null },
      });
      const queued = await enqueueWhitelistAdd(
        tx as unknown as WhitelistOutboxClient,
        { guildId: scope.guildId, nitradoConnId: connId },
        gameId,
      );
      return { resolved: true, queued };
    }));

    if (!result.resolved) {
      res.status(409).json({ error: 'Lokaler Drift-Eintrag wurde zwischenzeitlich geaendert. Bitte neu laden.' });
      return;
    }

    logAuditDb('NITRADO_WHITELIST_DRIFT_RESOLVED', 'WHITELIST', {
      actorUserId: req.auth!.userId,
      guildId: scope.guildId,
      details: { nitradoConnId: connId, gameId, decision, remoteQueued: result.queued },
    });
    emitGuildEvent(scope.guildId, { type: 'whitelist.changed', payload: { guildId: scope.guildId, action: 'drift_resolved' } });
    res.json({ ok: true, decision, queued: result.queued });
  } catch (error) {
    if (isAdmBindingFenceError(error)) {
      res.status(409).json({ error: 'Nitrado-Zuordnung hat sich waehrend der Drift-Aufloesung geaendert. Bitte erneut laden.' });
      return;
    }
    throw error;
  }
});

nitradoDriftRouter.get('/bans', requireGuildPermission('bans.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const resolved = await readBinding(scope, req.query.slot, res);
  if (!resolved) return;
  const { connId, binding } = resolved;
  const now = new Date();

  let remoteIdentifiers: string[];
  try {
    const token = decrypt(binding.encryptedToken, config.security.encryptionKey);
    remoteIdentifiers = (await new NitradoClient(token).getBanlist(binding.nitradoServerId)).map(row => row.identifier);
    await withFreshAdmBinding(binding, async () => undefined);
  } catch (error) {
    if (isAdmBindingFenceError(error)) {
      res.status(409).json({ error: 'Nitrado-Zuordnung hat sich waehrend der Drift-Pruefung geaendert. Bitte erneut laden.' });
      return;
    }
    logger.warn(`Ban-Drift-Read fehlgeschlagen fuer ${connId}: ${(error as Error).message}`);
    res.status(502).json({ error: 'Banliste konnte nicht frisch von Nitrado gelesen werden.' });
    return;
  }

  const remoteHashes = new Set(remoteIdentifiers
    .map(identifier => identifier.trim())
    .filter(Boolean)
    .map(identifier => hashBanIdentifier(identifier, config.security.encryptionKey)));

  const local = await prisma.serverBanEntry.findMany({
    where: {
      guildId: scope.guildId,
      nitradoConnId: connId,
      active: true,
      appliedRemotely: true,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    select: { id: true, identityHash: true, reason: true, bannedAt: true, expiresAt: true },
    orderBy: { bannedAt: 'desc' },
    take: 500,
  });
  const missing = local.filter(row => !remoteHashes.has(row.identityHash));
  const identities = missing.length > 0
    ? await prisma.serverBanRemoteIdentity.findMany({
        where: { banId: { in: missing.map(row => row.id) } },
        select: { banId: true, identifierEnc: true },
      })
    : [];
  const identityByBan = new Map(identities.map(row => [row.banId, row.identifierEnc]));

  const items = missing.map(row => {
    const identifierEnc = identityByBan.get(row.id);
    const identifier = identifierEnc ? safeDecryptIdentifier(identifierEnc, row.identityHash) : null;
    return {
      kind: 'BAN' as const,
      banId: row.id,
      identifier,
      identifierHint: identifier ? null : row.identityHash.slice(0, 12),
      reason: row.reason,
      bannedAt: row.bannedAt,
      expiresAt: row.expiresAt,
      state: 'REMOTE_MISSING' as const,
      canRestore: Boolean(identifier),
    };
  });

  res.json({ observedAt: new Date().toISOString(), items });
});

nitradoDriftRouter.post('/bans/resolve', requireGuildPermission('bans.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const decision = parseDecision(req.body?.decision);
  const banId = typeof req.body?.banId === 'string' ? req.body.banId.trim() : '';
  if (!decision || !banId) {
    res.status(400).json({ error: 'banId und decision (ACCEPT_NITRADO|RESTORE_VBOT) sind erforderlich.' });
    return;
  }
  if (decision === 'RESTORE_VBOT' && !ensureNitradoWriteAllowed(req, res, { action: 'NITRADO_BAN_DRIFT_RESTORE', danger: false })) return;

  const resolved = await readBinding(scope, req.query.slot, res);
  if (!resolved) return;
  const { connId, binding } = resolved;
  const now = new Date();

  const local = await prisma.serverBanEntry.findFirst({
    where: {
      id: banId,
      guildId: scope.guildId,
      nitradoConnId: connId,
      active: true,
      appliedRemotely: true,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    select: { id: true, identityHash: true },
  });
  if (!local) {
    res.status(409).json({ error: 'Lokaler Ban-Drift-Eintrag wurde zwischenzeitlich geaendert. Bitte neu laden.' });
    return;
  }

  let remoteIdentifiers: string[];
  try {
    const token = decrypt(binding.encryptedToken, config.security.encryptionKey);
    remoteIdentifiers = (await new NitradoClient(token).getBanlist(binding.nitradoServerId)).map(row => row.identifier);
  } catch (error) {
    logger.warn(`Ban-Drift-Resolve-Read fehlgeschlagen fuer ${connId}: ${(error as Error).message}`);
    res.status(502).json({ error: 'Banliste konnte nicht frisch von Nitrado gelesen werden.' });
    return;
  }
  if (remoteIdentifiers.some(identifier => matchesBanIdentifier(identifier, local.identityHash, config.security.encryptionKey))) {
    res.status(409).json({ error: 'Die Abweichung besteht nicht mehr: Der Ban ist wieder auf Nitrado vorhanden.' });
    return;
  }

  let restoreIdentifier: string | null = null;
  if (decision === 'RESTORE_VBOT') {
    const identity = await prisma.serverBanRemoteIdentity.findUnique({ where: { banId }, select: { identifierEnc: true } });
    restoreIdentifier = identity ? safeDecryptIdentifier(identity.identifierEnc, local.identityHash) : null;
    if (!restoreIdentifier) {
      res.status(409).json({ error: 'Der verschluesselte Gameserver-Identifier fehlt oder ist ungueltig. Automatische Wiederherstellung ist nicht sicher moeglich.' });
      return;
    }
  }

  try {
    const result = await withFreshAdmBinding(binding, () => prisma.$transaction(async tx => {
      const fresh = await tx.serverBanEntry.findFirst({
        where: {
          id: banId,
          guildId: scope.guildId,
          nitradoConnId: connId,
          active: true,
          appliedRemotely: true,
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
        select: { id: true },
      });
      if (!fresh) return { resolved: false, queued: false };

      if (decision === 'ACCEPT_NITRADO') {
        await tx.serverBanEntry.updateMany({
          where: { id: banId, guildId: scope.guildId, nitradoConnId: connId, active: true, appliedRemotely: true },
          data: { active: false, appliedRemotely: false, liftedAt: now },
        });
        await tx.serverBanExpiryNotice.updateMany({
          where: {
            banId,
            guildId: scope.guildId,
            nitradoConnId: connId,
            status: { in: ['PENDING', 'READY', 'SENDING', 'FAILED'] },
          },
          data: { status: 'CANCELLED', identifierEnc: null, leaseUntil: null, lastError: null },
        });
        await tx.serverBanRemoteIdentity.deleteMany({ where: { banId } });
        return { resolved: true, queued: false };
      }

      // Die explizite Admin-Entscheidung wandelt den Drift in einen normalen
      // ausstehenden Soll-Add um. Der Worker hat bereits die Sicherheitsregel
      // `appliedRemotely === true -> ADD no-op`; deshalb muss dieses Flag vor
      // dem bewusst eingereihten Restore atomar auf false wechseln.
      await tx.serverBanEntry.updateMany({
        where: { id: banId, guildId: scope.guildId, nitradoConnId: connId, active: true, appliedRemotely: true },
        data: { appliedRemotely: false },
      });
      const queued = await enqueueServerBanAdd(
        tx as unknown as BanOutboxClient,
        { guildId: scope.guildId, nitradoConnId: connId },
        banId,
        restoreIdentifier!,
        config.security.encryptionKey,
      );
      return { resolved: true, queued };
    }));

    if (!result.resolved) {
      res.status(409).json({ error: 'Lokaler Ban-Drift-Eintrag wurde zwischenzeitlich geaendert. Bitte neu laden.' });
      return;
    }

    logAuditDb('NITRADO_BAN_DRIFT_RESOLVED', 'MODERATION', {
      actorUserId: req.auth!.userId,
      guildId: scope.guildId,
      details: { nitradoConnId: connId, banId, decision, remoteQueued: result.queued },
    });
    emitGuildEvent(scope.guildId, { type: 'nitrado.drift.resolved', payload: { guildId: scope.guildId, nitradoConnId: connId, kind: 'BAN' } });
    res.json({ ok: true, decision, queued: result.queued });
  } catch (error) {
    if (isAdmBindingFenceError(error)) {
      res.status(409).json({ error: 'Nitrado-Zuordnung hat sich waehrend der Drift-Aufloesung geaendert. Bitte erneut laden.' });
      return;
    }
    throw error;
  }
});
