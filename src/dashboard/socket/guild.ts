/**
 * /guild Namespace — Guild- und Gameserver-Streams.
 *
 * Rooms:
 *  - `g:<guildId>`: guild-weite Konfig-/UI-Aenderungen
 *  - `gs:<guildId>:<nitradoConnId>`: Gameplay eines EXAKTEN Gameservers
 *
 * Der Server-Room ist absichtlich enger als der Guild-Room. Live-Gameplay ist
 * Killfeed-Daten und verlangt Owner oder killfeed.view/manage bzw. den bewusst
 * delegierbaren dashboard.access-Allzugriff. Ein beliebiger anderer Guild-Scope
 * reicht NICHT.
 */

import type { Server as IOServer, Socket } from 'socket.io';
import prisma from '../../database/prisma';
import { resolveDelegatedPermissionContext } from '../../modules/permissions/access';
import { logger } from '../../utils/logger';
import { tryGetDashboardClient } from '../clientRegistry';
import type { SocketSessionShape } from './index';
import { radarRoomName, serverRoomName } from './emitter';

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

export function radarPermissionAllows(isOwner: boolean, permissions: readonly string[]): boolean {
  if (isOwner) return true;
  const set = new Set(permissions);
  return set.has('radar.view') || set.has('radar.manage') || set.has('dashboard.access');
}

export interface GuildAccessResult {
  allowed: boolean;
  isOwner: boolean;
  permissions: string[];
}

/** Socket und HTTP teilen dieselbe aktuelle Member-/Grant-Wahrheit. */
export async function resolveGuildAccess(guildId: string, userDiscordId: string): Promise<GuildAccessResult> {
  const client = tryGetDashboardClient();
  const guild = client?.guilds.cache.get(guildId);
  if (!guild) return { allowed: false, isOwner: false, permissions: [] };
  const isOwner = guild.ownerId === userDiscordId;
  if (isOwner) return { allowed: true, isOwner: true, permissions: [] };

  const delegated = await resolveDelegatedPermissionContext(guild, userDiscordId);
  if (!delegated.member) return { allowed: false, isOwner: false, permissions: [] };
  return {
    allowed: delegated.permissions.size > 0,
    isOwner: false,
    permissions: [...delegated.permissions],
  };
}

function sessionFor(socket: Socket): SocketSessionShape {
  const req = socket.request as { session?: SocketSessionShape };
  return req.session as SocketSessionShape;
}

const GUILD_AUTH_RECHECK_MS = 5_000;

// Access is only checked at join-time above. Without this sweep, a guild owner revoking a
// moderator's grant (or the moderator leaving the guild) would leave that moderator's
// already-joined socket receiving economy/casino/killfeed/radar events until it happens to
// disconnect and reconnect. Each tick re-derives current membership/permissions fresh from
// Discord + DB (the same resolveGuildAccess() the HTTP routes use) and leaves any room the
// socket is no longer entitled to — mirroring the /dev namespace's continuous revalidation.
async function revalidateSocketRooms(socket: Socket, userDiscordId: string): Promise<void> {
  const accessCache = new Map<string, GuildAccessResult>();
  const accessFor = async (guildId: string): Promise<GuildAccessResult> => {
    const cached = accessCache.get(guildId);
    if (cached) return cached;
    const access = await resolveGuildAccess(guildId, userDiscordId);
    accessCache.set(guildId, access);
    return access;
  };

  for (const room of socket.rooms) {
    if (room === socket.id) continue;
    const parts = room.split(':');
    if (parts[0] === 'g' && parts.length === 2 && isSnowflake(parts[1])) {
      const access = await accessFor(parts[1]);
      if (!access.allowed) await socket.leave(room);
    } else if (parts[0] === 'gs' && parts.length === 3 && isSnowflake(parts[1]) && isConnectionId(parts[2])) {
      const access = await accessFor(parts[1]);
      if (!serverFeedPermissionAllows(access.isOwner, access.permissions)) await socket.leave(room);
    } else if (parts[0] === 'gr' && parts.length === 3 && isSnowflake(parts[1]) && isConnectionId(parts[2])) {
      const access = await accessFor(parts[1]);
      if (!radarPermissionAllows(access.isOwner, access.permissions)) await socket.leave(room);
    }
  }
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

    socket.on('join.radar', async (payload: JoinServerPayload) => {
      const gid = payload?.guildId;
      const connId = payload?.nitradoConnId;
      if (!isSnowflake(gid) || !isConnectionId(connId)) {
        socket.emit('join.radar.error', { error: 'guildId/nitradoConnId ungueltig' });
        return;
      }
      try {
        const access = await resolveGuildAccess(gid, userDiscordId);
        if (!radarPermissionAllows(access.isOwner, access.permissions)) {
          socket.emit('join.radar.error', { guildId: gid, nitradoConnId: connId, error: 'radar.view erforderlich' });
          return;
        }
        const conn = await prisma.nitradoConnection.findFirst({
          where: { id: connId, guildId: gid, status: 'ACTIVE', nitradoServerId: { not: null }, slot: { gte: 1, lte: 4 } },
          select: { id: true },
        });
        if (!conn) {
          socket.emit('join.radar.error', { guildId: gid, nitradoConnId: connId, error: 'Gameserver nicht aktiv/gebunden' });
          return;
        }
        await socket.join(radarRoomName(gid, connId));
        socket.emit('join.radar.ok', { guildId: gid, nitradoConnId: connId });
      } catch (error) {
        logger.error('Radar-Room-Join-Fehler:', error as Error);
        socket.emit('join.radar.error', { guildId: gid, nitradoConnId: connId, error: 'internal' });
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

    socket.on('leave.radar', async (payload: JoinServerPayload) => {
      const gid = payload?.guildId;
      const connId = payload?.nitradoConnId;
      if (!isSnowflake(gid) || !isConnectionId(connId)) return;
      await socket.leave(radarRoomName(gid, connId));
      socket.emit('leave.radar.ok', { guildId: gid, nitradoConnId: connId });
    });

    socket.on('disconnect', reason => {
      logger.debug(`/guild getrennt: ${socket.id} (${reason})`);
    });
  });

  // Fortlaufende serverseitige AuthZ pro Room (siehe revalidateSocketRooms oben).
  let authSweepRunning = false;
  setInterval(() => {
    if (authSweepRunning || ns.sockets.size === 0) return;
    authSweepRunning = true;
    void (async () => {
      for (const socket of ns.sockets.values()) {
        const userDiscordId = sessionFor(socket)?.discordId;
        if (!userDiscordId) {
          socket.disconnect(true);
          continue;
        }
        try {
          await revalidateSocketRooms(socket, userDiscordId);
        } catch (error) {
          logger.error('Guild-Namespace-Revalidierung fehlgeschlagen:', error as Error);
        }
      }
    })().finally(() => { authSweepRunning = false; });
  }, GUILD_AUTH_RECHECK_MS).unref();
}
