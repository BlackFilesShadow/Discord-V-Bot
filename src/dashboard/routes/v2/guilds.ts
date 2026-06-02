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
import rateLimit from 'express-rate-limit';
import axios from 'axios';
import { tryGetDashboardClient, getDashboardClient } from '../../clientRegistry';
import { getOrCreate, get as getDashLink } from '../../../modules/dashboard/repository';
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
  // BEWUSST GLOBAL: User-View zeigt alle Guilds, in denen er Permissions hat.
  // Es gibt keinen guildId-Filter, weil wir genau die Liste DER guildIds suchen.
  // eslint-disable-next-line local/no-unscoped-prisma-query
  const grants = await prisma.guildPermissionGrant.findMany({
    where: { userDiscordId: req.auth.discordId },
    select: { guildId: true, permissions: true },
  });
  const grantedGuildIds = new Set(
    grants
      .filter(g => Array.isArray(g.permissions) && (g.permissions as string[]).length > 0)
      .map(g => g.guildId),
  );

  // Schritt 2b: Role-basierte Grants. Eine Guild ist auch dann sichtbar, wenn der
  // User dort eine Rolle traegt, der mindestens 1 Scope zugewiesen wurde
  // (z. B. `dashboard.access` fuer eine Supporter-Rolle).
  //
  // Performance: EINE DB-Query holt alle (guildId, roleDiscordId)-Tupel mit Grants;
  // anschliessend nur die Guilds pruefen, in denen ueberhaupt Role-Grants existieren
  // (typisch < 5). Member wird primaer aus dem Cache geholt — Discord-API-Fetch nur
  // dann, wenn fuer diese Guild Grants existieren UND der User dort nicht gecached ist.
  const allRoleGrants = await prisma.guildPermissionRoleGrant.findMany({
    select: { guildId: true, roleDiscordId: true, permissions: true },
  });
  const grantsByGuild = new Map<string, Set<string>>();
  for (const rg of allRoleGrants) {
    if (!Array.isArray(rg.permissions) || (rg.permissions as string[]).length === 0) continue;
    let s = grantsByGuild.get(rg.guildId);
    if (!s) { s = new Set(); grantsByGuild.set(rg.guildId, s); }
    s.add(rg.roleDiscordId);
  }
  for (const [gId, grantedRoleIds] of grantsByGuild.entries()) {
    if (grantedGuildIds.has(gId)) continue;
    const cached = client.guilds.cache.get(gId);
    if (!cached) continue;
    const member = cached.members.cache.get(req.auth.discordId)
      ?? await cached.members.fetch(req.auth.discordId).catch(() => null);
    if (!member) continue;
    let hit = false;
    for (const rid of member.roles.cache.keys()) {
      if (grantedRoleIds.has(rid)) { hit = true; break; }
    }
    if (hit) grantedGuildIds.add(gId);
  }

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
guildsRouter.get('/:guildId/channels', requireGuildAccess, async (req, res) => {
  const client = tryGetDashboardClient();
  if (!client) { res.status(503).json({ error: 'Bot nicht bereit.' }); return; }
  const guildId = req.guildScope!.guildId;
  const guild = client.guilds.cache.get(guildId);
  if (!guild) { res.status(404).json({ error: 'Bot nicht in Guild.' }); return; }

  // 0 = Text, 4 = Category, 5 = Announcement, 15 = Forum
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

  // Optionale Rollen-Suche (?q=). Filtert nach Name (case-insensitive) oder ID.
  const rawQ = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 64).toLowerCase() : '';

  let roles = guild.roles.cache
    .filter(r => r.id !== guild.id) // @everyone raus
    .map(r => ({ id: r.id, name: r.name, color: r.hexColor, position: r.position, managed: r.managed }))
    .sort((a, b) => b.position - a.position);
  if (rawQ.length > 0) {
    roles = roles.filter(r => r.name.toLowerCase().includes(rawQ) || r.id.includes(rawQ));
  }
  res.json({ roles });
});

/**
 * Liefert bis zu 25 Mitglieder einer Guild fuer Autocomplete.
 * Owner-only (User-IDs sind sensibel).
 *
 * Query:
 *   ?q=<prefix>     Discord-API-Member-Search (Prefix). Ohne `q`: Cache-Top.
 *   ?limit=<1..25>  optionales Limit (default 25, max 25 von Discord).
 */
// Schützt vor Discord-API-Quote-Verbrauch durch Rapid-Fire-Autocomplete.
const memberSearchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30, // 30 Suchanfragen pro Minute pro User/IP
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

  // Hard-Limit/Sanitize: max 64 Zeichen, kein Steuerzeichen.
  const q = rawQ.slice(0, 64).replace(/[\u0000-\u001f]/g, '');

  try {
    let members;
    if (q.length > 0) {
      // Discord-API: Prefix-Search (queryt server-side).
      members = await guild.members.search({ query: q, limit });
    } else {
      // Ohne Query: liefere die Top-25 aus dem Cache (z.B. zuletzt aktive).
      members = guild.members.cache.first(limit);
    }
    const result = (Array.from(members.values?.() ?? members)).map(m => ({
      id: m.id,
      username: m.user.username,
      displayName: m.displayName ?? m.user.globalName ?? m.user.username,
      // Avatar-Hash (oder null bei Default-Avatar). Frontend baut die
      // CDN-URL selbst — so bleibt das API-Format konsistent mit dem,
      // was die Permission-Endpoints liefern.
      avatar: m.user.avatar ?? null,
      bot: m.user.bot,
    }));
    res.json({ members: result });
  } catch (e) {
    res.status(502).json({ error: 'Discord-Member-Search fehlgeschlagen.', detail: (e as Error).message });
  }
});
