/**
 * GET  /api/v2/guilds                         vollstaendige Owner-Liste
 * POST /api/v2/guilds/:guildId/activate       erstellt DashboardGuildLink
 *
 * Owner-Liste wird in zwei Schritten aufgebaut:
 *  1) Discord OAuth /users/@me/guilds — alle Guilds des Users mit
 *     owner=true Flag ODER MANAGE_GUILD-Permission. Erfordert Access-Token
 *     im Server-RAM-Cache (wird beim OAuth-Callback gesetzt).
 *  2) Bot-Cache (Client.guilds.cache) — markiert welche dieser Guilds den
 *     Bot bereits haben (botPresent=true) und liefert alias5 aus DB-Link.
 *
 * Guilds OHNE Bot bekommen `botPresent=false` + `inviteUrl`, damit der
 * Owner direkt im Dashboard "Bot einladen" klicken kann.
 *
 * Wenn der Discord-API-Call fehlschlaegt (Token abgelaufen, Rate-Limit,
 * Netz), wird auf den Bot-Cache + ownerId-Filter zurueckgefallen.
 */
import { Router } from 'express';
import axios from 'axios';
import { tryGetDashboardClient, getDashboardClient } from '../../clientRegistry';
import { getOrCreate, get as getDashLink } from '../../../modules/dashboard/repository';
import { asGuildId, asUserDiscordId } from '../../../types/scope';
import { getDiscordAccessToken } from '../auth';
import { config } from '../../../config';
import { logger } from '../../../utils/logger';

export const guildsRouter = Router();

// Discord-Permissions-Bit MANAGE_GUILD
const MANAGE_GUILD_BIT = 0x20n;

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

  // Schritt 1: Discord-API
  let userGuilds: DiscordUserGuild[] = [];
  const sessionToken = (req.session as { sessionToken?: string }).sessionToken;
  const accessToken = getDiscordAccessToken(sessionToken);
  if (accessToken) {
    try {
      const r = await axios.get<DiscordUserGuild[]>('https://discord.com/api/v10/users/@me/guilds', {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: 5000,
        validateStatus: () => true,
      });
      if (r.status === 200 && Array.isArray(r.data)) {
        userGuilds = r.data.filter(g => {
          if (g.owner) return true;
          try { return (BigInt(g.permissions) & MANAGE_GUILD_BIT) !== 0n; } catch { return false; }
        });
      } else {
        logger.warn(`Discord /users/@me/guilds antwortete ${r.status}`);
      }
    } catch (e) {
      logger.warn('Discord /users/@me/guilds Fehler — fallback auf Bot-Cache.', e as Error);
    }
  }

  // Schritt 2: mergen
  const botGuildIds = new Set(client.guilds.cache.keys());
  const merged = new Map<string, {
    id: string; name: string; iconUrl: string | null; memberCount: number | null;
    botPresent: boolean; alias5: string | null; isOwner: boolean; inviteUrl?: string;
  }>();

  for (const g of userGuilds) {
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
      isOwner: g.owner,
      ...(present ? {} : { inviteUrl: buildInviteUrl(g.id) }),
    });
  }

  // Fallback: Bot-Cache + ownerId, falls Discord-API nichts lieferte
  if (merged.size === 0) {
    for (const g of client.guilds.cache.values()) {
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
