import type { NextFunction, Request, Response } from 'express';
import type { Guild, GuildBasedChannel, Role } from 'discord.js';
import { tryGetDashboardClient } from '../clientRegistry';

const SNOWFLAKE = /^\d{17,20}$/;
const MAX_ROLE_IDS = 250;
const MAX_CHANNEL_IDS = 500;

function xpGuildId(req: Request): string | null {
  const match = req.path.match(/^\/xp\/(\d{17,20})(?:\/|$)/);
  return match?.[1] ?? null;
}

async function resolveGuild(req: Request, res: Response): Promise<Guild | null> {
  const guildId = xpGuildId(req);
  if (!guildId) return null;

  const restricted = req.devSession?.scope.guildIdRestrict;
  if (restricted && restricted !== guildId) {
    res.status(403).json({ error: 'DEV-Session ist auf eine andere Guild beschränkt.', code: 'DEV_GUILD_SCOPE_DENIED' });
    return null;
  }

  const client = tryGetDashboardClient();
  if (!client) {
    res.status(503).json({ error: 'Discord-Client nicht verfügbar.' });
    return null;
  }

  const guild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) {
    res.status(404).json({ error: 'Guild ist für diesen Bot nicht verfügbar.' });
    return null;
  }
  return guild;
}

async function resolveRole(guild: Guild, roleId: string): Promise<Role | null> {
  const role = guild.roles.cache.get(roleId) ?? await guild.roles.fetch(roleId).catch(() => null);
  if (!role || role.id === guild.id || role.managed) return null;
  return role;
}

async function resolveChannel(guild: Guild, channelId: string): Promise<GuildBasedChannel | null> {
  return guild.channels.cache.get(channelId) ?? await guild.channels.fetch(channelId).catch(() => null);
}

async function validateRoleIds(guild: Guild, raw: unknown): Promise<boolean> {
  if (!Array.isArray(raw) || raw.length > MAX_ROLE_IDS) return false;
  const ids = [...new Set(raw)];
  if (!ids.every(id => typeof id === 'string' && SNOWFLAKE.test(id))) return false;
  const resolved = await Promise.all(ids.map(id => resolveRole(guild, id as string)));
  return resolved.every(Boolean);
}

async function validateChannelIds(guild: Guild, raw: unknown): Promise<boolean> {
  if (!Array.isArray(raw) || raw.length > MAX_CHANNEL_IDS) return false;
  const ids = [...new Set(raw)];
  if (!ids.every(id => typeof id === 'string' && SNOWFLAKE.test(id))) return false;
  const resolved = await Promise.all(ids.map(id => resolveChannel(guild, id as string)));
  return resolved.every(Boolean);
}

/**
 * Die aktuelle Command-Center-UI startet die optionalen ID-Felder leer. Ohne
 * diese Kompatibilitaet wuerde schon eine Aenderung von z.B. messageXpMin
 * gleichzeitig bestehende Allow-Lists und die Max-Level-Rolle loeschen.
 *
 * Explizites Leeren bleibt fuer API/kuenftige UI moeglich, aber nur ueber ein
 * bewusst gesetztes Clear-Flag. Dadurch ist ein leeres Initialfeld niemals
 * stillschweigend destruktiv.
 */
function preserveUneditedOptionalXpFields(req: Request): void {
  if (!req.body || typeof req.body !== 'object') return;
  const body = req.body as Record<string, unknown>;

  if (body.maxLevelRoleId === null && body.clearMaxLevelRoleId !== true) {
    delete body.maxLevelRoleId;
  }
  if (Array.isArray(body.allowedRoleIds) && body.allowedRoleIds.length === 0 && body.clearAllowedRoleIds !== true) {
    delete body.allowedRoleIds;
  }
  if (Array.isArray(body.allowedChannelIds) && body.allowedChannelIds.length === 0 && body.clearAllowedChannelIds !== true) {
    delete body.allowedChannelIds;
  }

  // Steuerflags gehoeren nicht in Prisma-Daten und werden nach der
  // Kompatibilitaetsentscheidung immer entfernt.
  delete body.clearMaxLevelRoleId;
  delete body.clearAllowedRoleIds;
  delete body.clearAllowedChannelIds;
}

/**
 * Stellt die Discord-Referenzintegritaet der aus `/xp-config` migrierten
 * Dashboard-Funktionen wieder her.
 *
 * Der fruehere Slash-Command konnte nur die aktuelle echte Guild sowie echte
 * Discord-Rollen/Channels aus Discord-Optionen verwenden. HTTP-Payloads duerfen
 * diese Grenze nicht durch frei erfundene Snowflakes oder IDs anderer Guilds
 * umgehen. Deshalb gilt fuer alle XP-Routen fail-closed:
 * - Guild muss fuer den laufenden Bot erreichbar sein,
 * - optionale DEV-Guild-Restriction muss passen,
 * - Rollen muessen dieser Guild gehoeren und duerfen weder @everyone noch
 *   managed Rollen sein,
 * - Channels muessen dieser Guild gehoeren.
 */
export async function guardDevXpGuildObjects(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!req.path.startsWith('/xp/')) {
    next();
    return;
  }

  const guildId = xpGuildId(req);
  if (!guildId || !SNOWFLAKE.test(guildId)) {
    res.status(400).json({ error: 'Ungültige guildId.' });
    return;
  }

  const guild = await resolveGuild(req, res);
  if (!guild) return;

  const method = req.method.toUpperCase();
  if (method === 'PATCH' && req.path === `/xp/${guildId}`) {
    preserveUneditedOptionalXpFields(req);

    if (req.body?.maxLevelRoleId !== undefined && req.body.maxLevelRoleId !== null) {
      const roleId = String(req.body.maxLevelRoleId);
      if (!SNOWFLAKE.test(roleId) || !(await resolveRole(guild, roleId))) {
        res.status(400).json({ error: 'maxLevelRoleId gehört nicht zu dieser Guild oder ist nicht verwendbar.' });
        return;
      }
    }
    if (req.body?.allowedRoleIds !== undefined && !(await validateRoleIds(guild, req.body.allowedRoleIds))) {
      res.status(400).json({ error: 'allowedRoleIds enthalten fremde, ungültige oder nicht verwendbare Rollen.' });
      return;
    }
    if (req.body?.allowedChannelIds !== undefined && !(await validateChannelIds(guild, req.body.allowedChannelIds))) {
      res.status(400).json({ error: 'allowedChannelIds enthalten fremde oder ungültige Channels.' });
      return;
    }
  }

  if (method === 'PUT' && /^\/xp\/\d{17,20}\/level-role\/\d+$/.test(req.path)) {
    const roleId = String(req.body?.roleId ?? '');
    if (!SNOWFLAKE.test(roleId) || !(await resolveRole(guild, roleId))) {
      res.status(400).json({ error: 'roleId gehört nicht zu dieser Guild oder ist nicht verwendbar.' });
      return;
    }
  }

  next();
}
