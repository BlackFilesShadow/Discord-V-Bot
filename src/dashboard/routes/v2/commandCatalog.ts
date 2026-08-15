import { Router } from 'express';
import { tryGetDashboardClient } from '../../clientRegistry';
import { buildCommandCatalog, commandCatalogSummary } from '../../../commands/catalog';
import type { ExtendedClient } from '../../../types';

export const commandCatalogRouter = Router();

/**
 * Same source of truth as Discord /help and the scoped Discord deploy. The
 * surrounding v2 mount applies the global Bot-Admin identity gate, so this
 * endpoint does not create a second permission model.
 */
commandCatalogRouter.get('/', (_req, res) => {
  const client = tryGetDashboardClient();
  if (!client) {
    res.status(503).json({ ready: false, commands: [], summary: null });
    return;
  }
  const commands = buildCommandCatalog(client as ExtendedClient).filter((entry) => entry.staysInDiscord);
  res.json({
    ready: true,
    commands,
    summary: commandCatalogSummary(commands),
    generatedAt: new Date().toISOString(),
  });
});
