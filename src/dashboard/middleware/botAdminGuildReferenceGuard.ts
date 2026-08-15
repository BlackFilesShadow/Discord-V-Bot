import type { NextFunction, Request, Response } from 'express';
import { tryGetDashboardClient } from '../clientRegistry';

const SNOWFLAKE = /^\d{17,20}$/;

function firstString(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0].trim();
  return '';
}

function requestedGuildId(req: Request): string {
  return firstString(req.query.guildId) || firstString((req.body as { guildId?: unknown } | undefined)?.guildId);
}

/**
 * Gemeinsame Discord-Referenzgrenze fuer die aelteren guild-gebundenen
 * Bot-Admin-Dashboard-Routen. HTTP-Snowflakes duerfen die Referenzintegritaet
 * nicht umgehen, die fruehere Discord-Auswahl automatisch geliefert hat.
 */
export async function guardBotAdminGuildReferences(req: Request, res: Response, next: NextFunction): Promise<void> {
  const guildId = requestedGuildId(req);
  if (!guildId) {
    next();
    return;
  }
  if (!SNOWFLAKE.test(guildId)) {
    res.status(400).json({ error: 'guildId ist ungueltig.' });
    return;
  }

  const client = tryGetDashboardClient();
  if (!client) {
    res.status(503).json({ error: 'Discord-Client nicht verfügbar.' });
    return;
  }
  const guild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) {
    res.status(404).json({ error: 'Guild ist für diesen Bot nicht verfügbar.' });
    return;
  }

  const channelId = firstString((req.body as { channelId?: unknown } | undefined)?.channelId);
  if (channelId) {
    if (!SNOWFLAKE.test(channelId)) {
      res.status(400).json({ error: 'channelId ist ungueltig.' });
      return;
    }
    const channel = guild.channels.cache.get(channelId) ?? await guild.channels.fetch(channelId).catch(() => null);
    if (!channel) {
      res.status(400).json({ error: 'channelId gehört nicht zur ausgewählten Guild.' });
      return;
    }
  }

  const roleId = firstString((req.body as { roleId?: unknown } | undefined)?.roleId);
  if (roleId) {
    if (!SNOWFLAKE.test(roleId)) {
      res.status(400).json({ error: 'roleId ist ungueltig.' });
      return;
    }
    const role = guild.roles.cache.get(roleId) ?? await guild.roles.fetch(roleId).catch(() => null);
    if (!role || role.id === guild.id || role.managed) {
      res.status(400).json({ error: 'roleId gehört nicht als verwendbare Rolle zur ausgewählten Guild.' });
      return;
    }
  }

  next();
}
