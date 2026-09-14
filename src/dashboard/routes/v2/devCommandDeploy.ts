import { Router } from 'express';
import { requireDev } from '../../middleware/auth';
import { logDevAction } from '../../middleware/devSecurity';
import { tryGetDashboardClient } from '../../clientRegistry';
import { loadCommands, deployCommandsScoped } from '../../../commands/handler';
import { config } from '../../../config';

export const devCommandDeployRouter = Router();
devCommandDeployRouter.use(requireDev);

// In-Process-Lock: verhindert, dass zwei gleichzeitige Reload-Requests dieselbe
// `client.commands`-Registry ueberlappend mutieren und redundant/interleaved
// an die Discord-REST-API deployen. Der Bot-Client ist Prozess-lokal (kein
// Multi-Worker-Setup fuer denselben Token), daher reicht ein einfaches
// In-Memory-Flag -- kein Postgres-Advisory-Lock noetig, dessen Pattern
// ausdruecklich fuer "schnelle" Mutationen gedacht ist (siehe
// factionMutationSerialization), waehrend ein Multi-Guild-Deploy deutlich
// laenger laufen kann.
let reloadInProgress = false;

/**
 * Kanonischer Dashboard-Pfad fuer Command Reload/Deploy.
 *
 * - `loadCommands` arbeitet atomar und ersetzt die Runtime-Registry erst nach
 *   erfolgreichem vollständigem Load.
 * - Ein Guild-Teilfehler wird nicht als Erfolg verkauft: HTTP 502 + konkrete
 *   fehlgeschlagene Guild-IDs. Der globale Deploy kann trotzdem bereits erfolgt
 *   sein, deshalb ist die Antwort bewusst "unvollständig" statt Rollback-Illusion.
 */
devCommandDeployRouter.post('/commands/reload', async (req, res) => {
  if (reloadInProgress) {
    res.status(409).json({ error: 'Command-Reload laeuft bereits. Bitte warten.' });
    return;
  }

  const scope = req.body?.scope === 'deploy' ? 'deploy' : 'all';
  const client = tryGetDashboardClient();
  if (!client) {
    res.status(503).json({ error: 'Discord-Client nicht verfügbar.' });
    return;
  }

  reloadInProgress = true;
  try {
    const oldCount = client.commands.size;
    if (scope === 'all') await loadCommands(client);

    const guildIds = [...client.guilds.cache.keys()];
    const result = await deployCommandsScoped(client, config.discord.token, config.discord.clientId, guildIds);
    const payload = { oldCount, newCount: client.commands.size, totalGuilds: guildIds.length, ...result };

    logDevAction('DEV_COMMAND_RELOAD', req, {
      scope,
      ...payload,
      reason: String(req.body.reason),
    });

    if (result.guildsFailed > 0) {
      res.status(502).json({
        error: `Command-Deploy unvollständig: ${result.guildsFailed}/${guildIds.length} Guild(s) fehlgeschlagen.`,
        ...payload,
      });
      return;
    }

    res.json(payload);
  } finally {
    reloadInProgress = false;
  }
});
