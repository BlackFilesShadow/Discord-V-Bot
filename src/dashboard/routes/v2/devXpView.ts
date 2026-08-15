import { Router } from 'express';
import prisma from '../../../database/prisma';
import { tryGetDashboardClient } from '../../clientRegistry';

const SNOWFLAKE = /^\d{17,20}$/;

export const devXpViewRouter = Router();

const XP_DEFAULTS = {
  messageXpMin: 15,
  messageXpMax: 25,
  voiceXpPerMinute: 5,
  eventXpBonus: 50,
  xpCooldownSeconds: 60,
  levelUpRoleIds: null,
  levelMultiplier: 1,
  isActive: true,
  allowedRoleIds: null,
  allowedChannelIds: null,
  maxLevel: 20,
  maxLevelRoleId: null,
} as const;

/** Read-only XP view: a GET never creates database state. */
devXpViewRouter.get('/xp/:guildId', async (req, res) => {
  const guildId = String(req.params.guildId ?? '');
  if (!SNOWFLAKE.test(guildId)) {
    res.status(400).json({ error: 'Ungültige guildId.' });
    return;
  }

  const restricted = req.devSession?.scope.guildIdRestrict;
  if (restricted && restricted !== guildId) {
    res.status(403).json({ error: 'DEV-Session ist auf eine andere Guild beschränkt.', code: 'DEV_GUILD_SCOPE_DENIED' });
    return;
  }

  const [stored, levelRoles] = await Promise.all([
    prisma.xpConfig.findUnique({ where: { id: guildId } }),
    prisma.levelRole.findMany({ where: { guildId }, orderBy: { level: 'asc' } }),
  ]);

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

  const roleOptions = [...guild.roles.cache.values()]
    .filter(role => !role.managed && role.id !== guild.id)
    .map(role => ({ id: role.id, name: role.name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const channelOptions = [...guild.channels.cache.values()]
    .filter(channel => typeof channel.name === 'string' && channel.name.length > 0)
    .map(channel => ({ id: channel.id, name: channel.name, type: channel.type }))
    .sort((a, b) => a.name.localeCompare(b.name));

  res.json({
    config: stored ?? { id: guildId, ...XP_DEFAULTS, createdAt: null, updatedAt: null },
    persisted: Boolean(stored),
    levelRoles,
    roleOptions,
    channelOptions,
  });
});
