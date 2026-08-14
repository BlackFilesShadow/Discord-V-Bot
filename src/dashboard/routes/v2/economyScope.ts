import { Router } from 'express';
import prisma from '../../../database/prisma';
import { requireGuildOwner } from '../../middleware/auth';
import { asGuildId, asNitradoConnId, asUserDiscordId } from '../../../types/scope';
import {
  getEconomyScopeMigrationState,
  resolveLegacyEconomyPrimaryServer,
} from '../../../modules/economy/scopeMigration';

export const economyScopeRouter = Router({ mergeParams: true });

/** Owner: aktueller Legacy-Migrationsstatus inkl. sichere Serverauswahl. */
economyScopeRouter.get('/status', requireGuildOwner, async (req, res) => {
  const guildId = asGuildId(String(req.params.guildId));
  const [state, conns] = await Promise.all([
    getEconomyScopeMigrationState(guildId),
    prisma.nitradoConnection.findMany({
      where: {
        guildId,
        status: 'ACTIVE',
        slot: { gte: 1, lte: 4 },
        nitradoServerId: { not: null },
      },
      select: { id: true, slot: true, alias: true, nitradoServerId: true },
      orderBy: { slot: 'asc' },
    }),
  ]);

  res.json({
    required: state?.status === 'MIGRATION_REQUIRED',
    state: state ? {
      status: state.status,
      primaryNitradoConnId: state.primaryNitradoConnId,
      detectedActiveServerCount: state.detectedActiveServerCount,
      resolvedAt: state.resolvedAt,
    } : null,
    servers: conns.map(c => ({ id: c.id, slot: c.slot, alias: c.alias, nitradoServerId: c.nitradoServerId })),
  });
});

/**
 * Owner: ordnet die bestehende guildweite Legacy-Economy exakt EINEM Server zu.
 * Kein Balance-Copy, keine automatische Verteilung auf weitere Slots.
 */
economyScopeRouter.post('/resolve', requireGuildOwner, async (req, res) => {
  const guildId = asGuildId(String(req.params.guildId));
  let connId;
  try {
    connId = asNitradoConnId(String(req.body?.nitradoConnId ?? ''));
  } catch {
    res.status(400).json({ error: 'nitradoConnId ungueltig.' });
    return;
  }

  try {
    const result = await resolveLegacyEconomyPrimaryServer({
      guildId,
      primaryNitradoConnId: connId,
      actorDiscordId: asUserDiscordId(req.auth!.discordId),
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(409).json({ error: (error as Error).message });
  }
});
