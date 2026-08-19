/**
 * GET  /api/v2/guilds                         vollstaendige Owner-/Grant-Liste
 * POST /api/v2/guilds/:guildId/activate       erstellt DashboardGuildLink
 *
 * Sichtbarkeitsregel (strikt): Owner ODER aktuelles Guild-Mitglied mit
 * mindestens einem bekannten delegierbaren Direct-/Role-Grant. Stale oder
 * korrupte DB-Grants duerfen eine Guild niemals sichtbar machen.
 */
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import axios from 'axios';
import { tryGetDashboardClient, getDashboardClient } from '../../clientRegistry';
import { getOrCreate, get as getDashLink } from '../../../modules/dashboard/repository';
import { resolveGuildPermissionAccess } from '../../../modules/permissions/access';
import { asGuildId, asUserDiscordId } from '../../../types/scope';
import { ensureDiscordAccessToken } from '../auth';
import { requireGuildAccess } from '../../middleware/auth';
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

  // Candidate discovery may be global, authorization never is: every candidate
  // is re-resolved through the canonical current-membership permission resolver.
  // eslint-disable-next-line local/no-unscoped-prisma-query
  const directCandidates = await prisma.guildPermissionGrant.findMany({
    where: { userDiscordId: req.auth.discordId },
    select: { guildId: true },
  });
  // eslint-disable-next-line local/no-unscoped-prisma-query
  const roleCandidates = await prisma.guildPermissionRoleGrant.findMany({
    select: { guildId: true },
  });
  const candidateGuildIds = new Set<string>([
    ...directCandidates.map(row => row.guildId),
    ...roleCandidates.map(row => row.guildId),
  ]);
  const grantedGuildIds = new Set<string>();
  for (const guildId of candidateGuildIds) {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) continue;
    const access = await resolveGuildPermissionAccess(guild, req.auth.discordId);
    if (!access.isOwner && access.allowed) grantedGuildIds.add(guildId);
  }

  const botGuildIds = new Set(client.guilds.cache.keys());
  const merged = new Map<string, {
    id: string; name: string; iconUrl: string | null; memberCount: number | null;
    botPresent: boolean; alias5: string | null; isOwner: boolean; inviteUrl?: string;
  }>();

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

  for (const guildId of grantedGuildIds) {
    if (merged.has(guildId)) continue;
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

guildsRouter.get('/:guildId/channels', requireGuildAccess, async (req, res) => {
  const client = tryGetDashboardClient();
  if (!client) { res.status(503).json({ error: 'Bot nicht bereit.' }); return; }
  const guildId = req.guildScope!.guildId;
  const guild = client.guilds.cache.get(guildId);
  if (!guild) { res.status(404).json({ error: 'Bot nicht in Guild.' }); return; }

  const channels = guild.channels.cache
    .filter(c => c.type === 0 || c.type === 4 || c.type === 5 || c.type === 15)
    .map(c => ({ id: c.id, name: c.name, type: c.type, parentId: c.parentId }))
    .sort((a, b) => a.name.localeCompare(b.name, 'de'));
  res.json({ channels });
});

guildsRouter.get('/:guildId/roles', requireGuildAccess, async (req, res) => {
  const client = tryGetDashboardClient();
  if (!client) { res.status(503).json({ error: 'Bot nicht bereit.' }); return; }
  const guildId = req.guildScope!.guildId;
  const guild = client.guilds.cache.get(guildId);
  if (!guild) { res.status(404).json({ error: 'Bot nicht in Guild.' }); return; }

  const rawQ = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 64).toLowerCase() : '';
  let roles = guild.roles.cache
    .filter(r => r.id !== guild.id)
    .map(r => ({ id: r.id, name: r.name, color: r.hexColor, position: r.position, managed: r.managed }))
    .sort((a, b) => b.position - a.position);
  if (rawQ.length > 0) {
    roles = roles.filter(r => r.name.toLowerCase().includes(rawQ) || r.id.includes(rawQ));
  }
  res.json({ roles });
});

const memberSearchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.auth?.discordId ?? req.ip ?? 'anon',
  message: { error: 'Zu viele Member-Suchen. Bitte kurz warten.' },
});

guildsRouter.get('/:guildId/members', memberSearchLimiter, requireGuildAccess, async (req, res) => {
  const client = tryGetDashboardClient();
  if (!client) { res.status(503).json({ error: 'Bot nicht bereit.' }); return; }
  const guildId = req.guildScope!.guildId;
  const guild = client.guilds.cache.get(guildId);
  if (!guild) { res.status(404).json({ error: 'Bot nicht in Guild.' }); return; }

  const rawQ = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const rawLimit = Number.parseInt(String(req.query.limit ?? '25'), 10);
  const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 25, 1), 25);
  const q = rawQ.slice(0, 64).replace(/[\u0000-\u001f]/g, '');

  try {
    let members;
    if (q.length > 0) {
      members = await guild.members.search({ query: q, limit });
    } else {
      members = guild.members.cache.first(limit);
    }
    const result = (Array.from(members.values?.() ?? members)).map(m => ({
      id: m.id,
      username: m.user.username,
      displayName: m.displayName ?? m.user.globalName ?? m.user.username,
      avatar: m.user.avatar ?? null,
      bot: m.user.bot,
    }));
    res.json({ members: result });
  } catch (e) {
    res.status(502).json({ error: 'Discord-Member-Search fehlgeschlagen.', detail: (e as Error).message });
  }
});
