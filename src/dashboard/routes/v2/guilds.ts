/**
 * GET  /api/v2/guilds                         vollstaendige Owner-Liste
 * POST /api/v2/guilds/:guildId/activate       erstellt DashboardGuildLink
 *
 * Sichtbarkeitsregel (strikt):
 *   Eine Guild wird AUSSCHLIESSLICH gelistet, wenn
 *     a) der eingeloggte User Discord-Owner der Guild ist, ODER
 *     b) der User einen GuildPermissionGrant (>=1 Scope) in unserer DB
 *        fuer diese Guild hat (z.B. vom Owner delegiert).
 *
 *   "Manage Guild"-Rechte aus Discord allein reichen NICHT, weil sie
 *   in unserem Modell nichts bedeuten.
 *
 * Quellen:
 *  1) Discord OAuth /users/@me/guilds — Owner-Flag pro Guild.
 *  2) DB GuildPermissionGrant — explizit delegierte Rechte.
 *  3) Bot-Cache — markiert botPresent + memberCount.
 *
 * Guilds OHNE Bot werden nur gelistet, wenn der User Owner ist
 * (Grants koennen ohne Bot-Praesenz nicht entstanden sein).
 */
import { Router } from 'express';
import axios from 'axios';
import { tryGetDashboardClient, getDashboardClient } from '../../clientRegistry';
import { getOrCreate, get as getDashLink } from '../../../modules/dashboard/repository';
import { asGuildId, asUserDiscordId } from '../../../types/scope';
import { ensureDiscordAccessToken } from '../auth';
import { config } from '../../../config';
import { logger } from '../../../utils/logger';
import prisma from '../../../database/prisma';

export const guildsRouter = Router();

interface DiscordUserGuild {
  id: string;
  name: string;
  icon: string | null;
  owner: boolean;
  permissions: string;
}

function buildInviteUrl(guildId: string): string {
  const params = new URLSearchParams({
    client_id: config.discord.clientId,
    scope: 'bot applications.commands',
    permissions: '8',
    guild_id: guildId,
    disable_guild_select: 'true',
  });
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

guildsRouter.get('/', async (req, res) => {
  if (!req.auth) { res.status(401).end(); return; }
  const client = tryGetDashboardClient();
  if (!client) { res.status(503).json({ error: 'Bot nicht bereit.' }); return; }

  // Schritt 1: Discord-API holen (nur fuer owner=true und Namen/Icons)
  let userGuilds: DiscordUserGuild[] = [];
  const sessionToken = (req.session as { sessionToken?: string }).sessionToken;
  const accessToken = await ensureDiscordAccessToken(sessionToken);
  if (accessToken) {
    try {
      const r = await axios.get<DiscordUserGuild[]>('https://discord.com/api/v10/users/@me/guilds', {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: 5000,
        validateStatus: () => true,
      });
      if (r.status === 200 && Array.isArray(r.data)) {
        userGuilds = r.data;
      } else {
        logger.warn(`Discord /users/@me/guilds antwortete ${r.status}`);
      }
    } catch (e) {
      logger.warn('Discord /users/@me/guilds Fehler — fallback auf Bot-Cache.', e as Error);
    }
  }

  // Schritt 2: Grants des Users aus DB (botPresent impliziert)
  const grants = await prisma.guildPermissionGrant.findMany({
    where: { userDiscordId: req.auth.discordId },
    select: { guildId: true, permissions: true },
  });
  const grantedGuildIds = new Set(
    grants
      .filter(g => Array.isArray(g.permissions) && (g.permissions as string[]).length > 0)
      .map(g => g.guildId),
  );

  // Schritt 3: nur Owner ODER granted -> mergen
  const botGuildIds = new Set(client.guilds.cache.keys());
  const merged = new Map<string, {
    id: string; name: string; iconUrl: string | null; memberCount: number | null;
    botPresent: boolean; alias5: string | null; isOwner: boolean; inviteUrl?: string;
  }>();

  // 3a) Owner-Guilds aus Discord-API (auch ohne Bot anzeigen, damit Bot eingeladen werden kann)
  for (const g of userGuilds) {
    if (!g.owner) continue;
    const present = botGuildIds.has(g.id);
    let memberCount: number | null = null;
    let alias5: string | null = null;
    if (present) {
      const cached = client.guilds.cache.get(g.id);
      memberCount = cached?.memberCount ?? null;
      const link = await getDashLink(asGuildId(g.id));
      alias5 = link?.alias5 ?? null;
    }
    merged.set(g.id, {
      id: g.id,
      name: g.name,
      iconUrl: g.icon
        ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.${g.icon.startsWith('a_') ? 'gif' : 'png'}?size=128`
        : null,
      memberCount,
      botPresent: present,
      alias5,
      isOwner: true,
      ...(present ? {} : { inviteUrl: buildInviteUrl(g.id) }),
    });
  }

  // 3b) Granted-Guilds (Bot muss da sein, sonst gibt's keinen Grant)
  for (const guildId of grantedGuildIds) {
    if (merged.has(guildId)) continue; // bereits als Owner drin
    const cached = client.guilds.cache.get(guildId);
    if (!cached) continue;
    const link = await getDashLink(asGuildId(guildId));
    merged.set(guildId, {
      id: guildId,
      name: cached.name,
      iconUrl: cached.iconURL({ size: 128 }) ?? null,
      memberCount: cached.memberCount,
      botPresent: true,
      alias5: link?.alias5 ?? null,
      isOwner: false,
    });
  }

  // Fallback: Discord-API hat nichts geliefert -> Bot-Cache + ownerId
  if (userGuilds.length === 0) {
    for (const g of client.guilds.cache.values()) {
      if (merged.has(g.id)) continue;
      if (g.ownerId !== req.auth.discordId) continue;
      const link = await getDashLink(asGuildId(g.id));
      merged.set(g.id, {
        id: g.id,
        name: g.name,
        iconUrl: g.iconURL({ size: 128 }) ?? null,
        memberCount: g.memberCount,
        botPresent: true,
        alias5: link?.alias5 ?? null,
        isOwner: true,
      });
    }
  }

  res.json({
    guilds: Array.from(merged.values()).sort((a, b) => a.name.localeCompare(b.name, 'de')),
  });
});

guildsRouter.post('/:guildId/activate', async (req, res) => {
  if (!req.auth) { res.status(401).end(); return; }
  const client = getDashboardClient();
  let guildId;
  try { guildId = asGuildId(String(req.params.guildId)); } catch {
    res.status(400).json({ error: 'guildId ungueltig.' }); return;
  }
  const guild = client.guilds.cache.get(guildId);
  if (!guild) { res.status(404).json({ error: 'Bot nicht in Guild.' }); return; }
  if (guild.ownerId !== req.auth.discordId) { res.status(403).json({ error: 'Nicht Owner.' }); return; }
  const link = await getOrCreate(guildId, asUserDiscordId(req.auth.discordId));
  res.json({ alias5: link.alias5, createdAt: link.createdAt });
});

/**
 * Liefert Text-Channels und Categories einer Guild fuer Dashboard-Selects.
 * Owner-only (Channel-IDs sind sensibel).
 */
guildsRouter.get('/:guildId/channels', async (req, res) => {
  if (!req.auth) { res.status(401).end(); return; }
  const client = tryGetDashboardClient();
  if (!client) { res.status(503).json({ error: 'Bot nicht bereit.' }); return; }
  let guildId;
  try { guildId = asGuildId(String(req.params.guildId)); } catch {
    res.status(400).json({ error: 'guildId ungueltig.' }); return;
  }
  const guild = client.guilds.cache.get(guildId);
  if (!guild) { res.status(404).json({ error: 'Bot nicht in Guild.' }); return; }
  if (guild.ownerId !== req.auth.discordId) { res.status(403).json({ error: 'Nicht Owner.' }); return; }

  // 0 = Text, 4 = Category, 5 = Announcement, 15 = Forum
  const channels = guild.channels.cache
    .filter(c => c.type === 0 || c.type === 4 || c.type === 5 || c.type === 15)
    .map(c => ({ id: c.id, name: c.name, type: c.type, parentId: c.parentId }))
    .sort((a, b) => a.name.localeCompare(b.name, 'de'));
  res.json({ channels });
});

guildsRouter.get('/:guildId/roles', async (req, res) => {
  if (!req.auth) { res.status(401).end(); return; }
  const client = tryGetDashboardClient();
  if (!client) { res.status(503).json({ error: 'Bot nicht bereit.' }); return; }
  let guildId;
  try { guildId = asGuildId(String(req.params.guildId)); } catch {
    res.status(400).json({ error: 'guildId ungueltig.' }); return;
  }
  const guild = client.guilds.cache.get(guildId);
  if (!guild) { res.status(404).json({ error: 'Bot nicht in Guild.' }); return; }
  if (guild.ownerId !== req.auth.discordId) { res.status(403).json({ error: 'Nicht Owner.' }); return; }

  const roles = guild.roles.cache
    .filter(r => r.id !== guild.id) // @everyone raus
    .map(r => ({ id: r.id, name: r.name, color: r.hexColor, position: r.position, managed: r.managed }))
    .sort((a, b) => b.position - a.position);
  res.json({ roles });
});
