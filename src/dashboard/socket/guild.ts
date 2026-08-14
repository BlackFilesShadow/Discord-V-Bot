/**
 * /guild Namespace — Guild- und Gameserver-Streams.
 *
 * Rooms:
 *  - `g:<guildId>`: guild-weite Konfig-/UI-Aenderungen
 *  - `gs:<guildId>:<nitradoConnId>`: Gameplay eines EXAKTEN Gameservers
 *
 * Der Server-Room ist absichtlich enger als der Guild-Room. Jeder Join prueft
 * Auth, Guild-Zugriff und die kanonische Guild+Connection-Bindung erneut.
 */

import type { Server as IOServer, Socket } from 'socket.io';
import prisma from '../../database/prisma';
import { logger } from '../../utils/logger';
import { tryGetDashboardClient } from '../clientRegistry';
import type { SocketSessionShape } from './index';
import { serverRoomName } from './emitter';

interface JoinPayload {
  guildId?: unknown;
}

interface JoinServerPayload extends JoinPayload {
  nitradoConnId?: unknown;
}

function isSnowflake(s: unknown): s is string {
  return typeof s === 'string' && /^[0-9]{17,20}$/.test(s);
}

function isConnectionId(s: unknown): s is string {
  return typeof s === 'string' && s.length >= 8 && s.length <= 128;
}

async function canAccessGuild(guildId: string, userDiscordId: string): Promise<boolean> {
  const client = tryGetDashboardClient();
  const guild = client?.guilds.cache.get(guildId);
  if (!guild) return false;
  if (guild.ownerId === userDiscordId) return true;

  const userGrant = await prisma.guildPermissionGrant.findUnique({
    where: { guildId_userDiscordId: { guildId, userDiscordId } },
    select: { permissions: true },
  });
  if (userGrant && Array.isArray(userGrant.permissions) && userGrant.permissions.length > 0) return true;

  // HTTP und Socket muessen dieselben Role-Grants respektieren. Sonst koennte
  // ein korrekt berechtigter Dashboard-Nutzer REST sehen, aber Live-Updates
  // verlieren (oder spaeter ein zweites, abweichendes Rechtemodell entstehen).
  const member = guild.members.cache.get(userDiscordId)
    ?? await guild.members.fetch(userDiscordId).catch(() => null);
  if (!member) return false;
  const roleIds = [...member.roles.cache.keys()];
  if (roleIds.length === 0) return false;
  const roleGrant = await prisma.guildPermissionRoleGrant.findFirst({
    where: {
      guildId,
      roleDiscordId: { in: roleIds },
      NOT: { permissions: { equals: [] } },
    },
    select: { id: true },
  });
  return Boolean(roleGrant);
}

function sessionFor(socket: Socket): SocketSessionShape {
  const req = socket.request as { session?: SocketSessionShape };
  return req.session as SocketSessionShape;
}

export function registerGuildNamespace(io: IOServer): void {
  const ns = io.of('/guild');

  ns.use((socket, next) => {
    const req = socket.request as { session?: SocketSessionShape };
    const session = req.session;
    if (!session?.userId || !session.discordId) {
      next(new Error('forbidden: not authenticated'));
      return;
    }
    if (session.requires2FA && !session.twoFactorVerified) {
      next(new Error('forbidden: 2FA pending'));
      return;
    }
    next();
  });

  ns.on('connection', socket => {
    const session = sessionFor(socket);
    const userDiscordId = session.discordId!;
    logger.debug(`/guild verbunden: ${socket.id} (user=${userDiscordId})`);

    socket.on('join', async (payload: JoinPayload) => {
      const gid = payload?.guildId;
      if (!isSnowflake(gid)) {
        socket.emit('join.error', { error: 'guildId ungueltig' });
        return;
      }
      try {
        if (!(await canAccessGuild(gid, userDiscordId))) {
          socket.emit('join.error', { guildId: gid, error: 'kein Scope fuer diese Guild' });
          return;
        }
        await socket.join(`g:${gid}`);
        socket.emit('join.ok', { guildId: gid });
      } catch (e) {
        logger.error('Guild-Namespace-Join-Fehler:', e as Error);
        socket.emit('join.error', { guildId: gid, error: 'internal' });
      }
    });

    socket.on('join.server', async (payload: JoinServerPayload) => {
      const gid = payload?.guildId;
      const connId = payload?.nitradoConnId;
      if (!isSnowflake(gid) || !isConnectionId(connId)) {
        socket.emit('join.server.error', { error: 'guildId/nitradoConnId ungueltig' });
        return;
      }
      try {
        if (!(await canAccessGuild(gid, userDiscordId))) {
          socket.emit('join.server.error', { guildId: gid, nitradoConnId: connId, error: 'kein Scope fuer diese Guild' });
          return;
        }

        // Fail-closed: nur ein aktuell aktiver, gebundener Slot 1..4 darf einen
        // Live-Gameserver-Room besitzen. Legacy-Slot 5 und fremde Guilds fallen
        // konstruktiv durch diese Abfrage.
        const conn = await prisma.nitradoConnection.findFirst({
          where: {
            id: connId,
            guildId: gid,
            status: 'ACTIVE',
            nitradoServerId: { not: null },
            slot: { gte: 1, lte: 4 },
          },
          select: { id: true },
        });
        if (!conn) {
          socket.emit('join.server.error', { guildId: gid, nitradoConnId: connId, error: 'Gameserver nicht aktiv/gebunden' });
          return;
        }

        await socket.join(serverRoomName(gid, connId));
        socket.emit('join.server.ok', { guildId: gid, nitradoConnId: connId });
      } catch (e) {
        logger.error('Gameserver-Room-Join-Fehler:', e as Error);
        socket.emit('join.server.error', { guildId: gid, nitradoConnId: connId, error: 'internal' });
      }
    });

    socket.on('leave', async (payload: JoinPayload) => {
      const gid = payload?.guildId;
      if (!isSnowflake(gid)) return;
      await socket.leave(`g:${gid}`);
      socket.emit('leave.ok', { guildId: gid });
    });

    socket.on('leave.server', async (payload: JoinServerPayload) => {
      const gid = payload?.guildId;
      const connId = payload?.nitradoConnId;
      if (!isSnowflake(gid) || !isConnectionId(connId)) return;
      await socket.leave(serverRoomName(gid, connId));
      socket.emit('leave.server.ok', { guildId: gid, nitradoConnId: connId });
    });

    socket.on('disconnect', reason => {
      logger.debug(`/guild getrennt: ${socket.id} (${reason})`);
    });
  });
}
