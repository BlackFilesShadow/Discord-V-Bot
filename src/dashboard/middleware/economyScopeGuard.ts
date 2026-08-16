import type { Request, Response, NextFunction } from 'express';
import prisma from '../../database/prisma';
import { asGuildId, asNitradoConnId } from '../../types/scope';
import { assertEconomyScopeReady, EconomyMigrationRequiredError, EconomyScopeMismatchError } from '../../modules/economy/scopeMigration';
import { MAX_GAME_SERVERS_PER_GUILD } from '../../modules/nitrado/gameServerScope';

/**
 * Serverseitige Dashboard-Scope-Grenze fuer Economy/Casino.
 *
 * - genau ein nutzbarer aktiver Gameserver => sichere Auto-Aufloesung;
 * - mehrere nutzbare Gameserver => `?nitradoConnId=<cuid>` ODER `?slot=N` ist Pflicht;
 * - expliziter Scope muss zur Guild gehoeren, ACTIVE sein, Slot 1..4 besitzen
 *   und eine gebundene Nitrado-Server-ID haben;
 * - wenn beide Parameter gesetzt sind, muessen sie denselben Server meinen;
 * - Legacy-Migration wird danach nochmals fail-closed geprueft;
 * - der validierte Scope wird in req.guildScope.nitradoConnId geschrieben.
 */
export async function requireSafeDashboardEconomyScope(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  let guildId;
  try {
    guildId = asGuildId(String(req.params.guildId ?? ''));
  } catch {
    res.status(400).json({ error: 'guildId ungueltig.' });
    return;
  }

  const connections = await prisma.nitradoConnection.findMany({
    where: {
      guildId,
      status: 'ACTIVE',
      slot: { gte: 1, lte: MAX_GAME_SERVERS_PER_GUILD },
      nitradoServerId: { not: null },
    },
    select: { id: true, slot: true, alias: true },
    orderBy: [{ slot: 'asc' }, { id: 'asc' }],
  });

  if (connections.length === 0) {
    res.status(409).json({ error: 'Kein aktiver Gameserver fuer Economy konfiguriert.', code: 'NO_ACTIVE_GAME_SERVER' });
    return;
  }

  const rawRequested = typeof req.query.nitradoConnId === 'string' ? req.query.nitradoConnId.trim() : '';
  const rawSlot = typeof req.query.slot === 'string' ? req.query.slot.trim() : '';
  let selected = connections.length === 1 && !rawRequested && !rawSlot ? connections[0] : null;

  if (rawRequested) {
    let requested;
    try { requested = asNitradoConnId(rawRequested); }
    catch {
      res.status(400).json({ error: 'nitradoConnId ungueltig.' });
      return;
    }
    selected = connections.find(c => c.id === requested) ?? null;
    if (!selected) {
      res.status(404).json({ error: 'Der ausgewaehlte Gameserver ist in dieser Guild nicht aktiv/nutzbar.', code: 'SERVER_NOT_FOUND' });
      return;
    }
  }

  if (rawSlot) {
    const slotNumber = Number(rawSlot);
    if (!Number.isInteger(slotNumber) || slotNumber < 1 || slotNumber > MAX_GAME_SERVERS_PER_GUILD) {
      res.status(400).json({ error: `slot muss zwischen 1 und ${MAX_GAME_SERVERS_PER_GUILD} liegen.`, code: 'INVALID_SERVER_SLOT' });
      return;
    }
    const bySlot = connections.find(c => c.slot === slotNumber) ?? null;
    if (!bySlot) {
      res.status(404).json({ error: 'Der ausgewaehlte Slot ist in dieser Guild nicht aktiv/nutzbar.', code: 'SERVER_NOT_FOUND' });
      return;
    }
    if (selected && selected.id !== bySlot.id) {
      res.status(400).json({ error: 'nitradoConnId und slot verweisen auf unterschiedliche Gameserver.', code: 'SERVER_SCOPE_CONFLICT' });
      return;
    }
    selected = bySlot;
  }

  if (!selected) {
    res.status(409).json({
      error: 'Mehrere Gameserver sind aktiv. Waehle einen Server explizit ueber nitradoConnId oder slot aus.',
      code: 'SERVER_SCOPE_REQUIRED',
      servers: connections.map(c => ({ id: c.id, slot: c.slot, alias: c.alias })),
    });
    return;
  }

  const nitradoConnId = asNitradoConnId(selected.id);
  try {
    await assertEconomyScopeReady(guildId, nitradoConnId);
  } catch (error) {
    if (error instanceof EconomyMigrationRequiredError || error instanceof EconomyScopeMismatchError) {
      res.status(409).json({ error: error.message, code: error.code });
      return;
    }
    throw error;
  }

  if (!req.guildScope) {
    res.status(500).json({ error: 'Guild-Scope fehlt nach Auth-Middleware.' });
    return;
  }
  req.guildScope.nitradoConnId = nitradoConnId;
  next();
}
