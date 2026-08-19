/**
 * /guild Namespace — Guild- und Gameserver-Streams.
 *
 * Rooms:
 *  - `g:<guildId>`: guild-weite Konfig-/UI-Aenderungen
 *  - `gs:<guildId>:<nitradoConnId>`: Gameplay eines EXAKTEN Gameservers
 */

import type { Server as IOServer, Socket } from 'socket.io';
import prisma from '../../database/prisma';
import { resolveGuildPermissionAccess } from '../../modules/permissions/access';
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
  return typeof s === 'string' && /^c[a-z0-9]{24}$/.test(s);
}

export function serverFeedPermissionAllows(isOwner: boolean, permissions: readonly string[]): boolean {
  if (isOwner) return true;
  const set = new Set(permissions);
  return set.has('killfeed.view') || set.has('killfeed.manage') || set.has('dashboard.access');
}

interface GuildAccessResult {
  allowed: boolean;
  isOwner: boolean;
  permissions: string[];
}

async function resolveGuildAccess(guildId: string, userDiscordId: string): Promise<GuildAccessResult> {
  const client = tryGetDashboardClient();
  const guild = client?.guilds.cache.get(guildId);
  if (!guild) return { allowed: false, isOwner: false, permissions: [] };

  const access = await resolveGuildPermissionAccess(guild, userDiscordId);
  return {
    allowed: access.allowed,
    isOwner: access.isOwner,
    permissions: [...access.permissions],
  };
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
        const access = await resolveGuildAccess(gid, userDiscordId);
        if (!access.allowed) {
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
        const access = await resolveGuildAccess(gid, userDiscordId);
        if (!serverFeedPermissionAllows(access.isOwner, access.permissions)) {
          socket.emit('join.server.error', { guildId: gid, nitradoConnId: connId, error: 'killfeed.view erforderlich' });
          return;
        }

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
