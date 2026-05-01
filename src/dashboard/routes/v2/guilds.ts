/**
 * GET /api/v2/guilds
 *
 * Liefert alle Discord-Guilds, in denen der eingeloggte User Owner ist,
 * + Flag ob der Bot dort drin ist + ggf. den 5-stelligen alias5.
 *
 * Quelle: aktuell verfuegbarer Bot-Cache (Client.guilds.cache) — fuer eine
 * vollstaendige Liste **aller** Owner-Guilds des Users brauchen wir die
 * Discord-OAuth-Guilds-API (separat, sobald wir Access-Tokens cachen).
 * Fuer jetzt: alle Guilds, in denen der Bot ist UND ownerId===user.
 *
 * (Sobald OAuth-Tokens persistent sind, wird hier zusaetzlich die
 * Owner-Guilds-Liste vom Discord-API-Endpunkt /users/@me/guilds gemerged
 * und Guilds OHNE Bot bekommen "needsInvite=true".)
 */
import { Router } from 'express';
import { getDashboardClient } from '../../clientRegistry';
import { tryGetDashboardClient } from '../../clientRegistry';
import { getOrCreate, get as getDashLink } from '../../../modules/dashboard/repository';
import { asGuildId, asUserDiscordId } from '../../../types/scope';

export const guildsRouter = Router();

guildsRouter.get('/', async (req, res) => {
  if (!req.auth) { res.status(401).end(); return; }
  const client = tryGetDashboardClient();
  if (!client) { res.status(503).json({ error: 'Bot nicht bereit.' }); return; }

  const ownedGuilds = client.guilds.cache.filter(g => g.ownerId === req.auth!.discordId);
  const result = await Promise.all(
    Array.from(ownedGuilds.values()).map(async g => {
      const link = await getDashLink(asGuildId(g.id));
      return {
        id: g.id,
        name: g.name,
        iconUrl: g.iconURL({ size: 128 }) ?? null,
        memberCount: g.memberCount,
        botPresent: true,
        alias5: link?.alias5 ?? null,
      };
    }),
  );
  res.json({ guilds: result });
});

// POST /api/v2/guilds/:guildId/activate
// Erstellt DashboardGuildLink (idempotent), Owner muss eingeloggt sein.
guildsRouter.post('/:guildId/activate', async (req, res) => {
  if (!req.auth) { res.status(401).end(); return; }
  const client = getDashboardClient();
  let guildId;
  try { guildId = asGuildId(String(req.params.guildId)); } catch { res.status(400).json({ error: 'guildId ungueltig.' }); return; }
  const guild = client.guilds.cache.get(guildId);
  if (!guild) { res.status(404).json({ error: 'Bot nicht in Guild.' }); return; }
  if (guild.ownerId !== req.auth.discordId) { res.status(403).json({ error: 'Nicht Owner.' }); return; }
  const link = await getOrCreate(guildId, asUserDiscordId(req.auth.discordId));
  res.json({ alias5: link.alias5, createdAt: link.createdAt });
});
