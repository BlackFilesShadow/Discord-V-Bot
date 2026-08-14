import type { Request, Response, NextFunction } from 'express';
import prisma from '../../database/prisma';
import { asGuildId } from '../../types/scope';

/**
 * Uebergangs-Guard fuer die noch guildweiten Dashboard-Economy/Casino-Routen.
 *
 * Solange diese HTTP-Routen keinen expliziten nitradoConnId-Scope tragen,
 * duerfen sie bei einer Multi-Server-Legacy-Economy niemals aggregierte oder
 * mutierbare guildweite Daten freigeben. Ein-Server-Guilds bleiben kompatibel.
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

  const state = await prisma.economyScopeMigration.findUnique({
    where: { guildId },
    select: {
      status: true,
      primaryNitradoConnId: true,
      detectedActiveServerCount: true,
    },
  });
  if (!state) {
    next();
    return;
  }

  if (state.status !== 'RESOLVED' || !state.primaryNitradoConnId) {
    res.status(409).json({
      error: 'Die Legacy-Economy muss zuerst einem Gameserver zugeordnet werden.',
      code: 'ECONOMY_MIGRATION_REQUIRED',
      detectedActiveServerCount: state.detectedActiveServerCount,
    });
    return;
  }

  if (state.detectedActiveServerCount > 1) {
    res.status(409).json({
      error: 'Mehrere Gameserver sind aktiv. Dieser Economy-Dashboard-Endpunkt benoetigt zuerst einen expliziten Server-Scope.',
      code: 'SERVER_SCOPE_REQUIRED',
    });
    return;
  }

  next();
}
