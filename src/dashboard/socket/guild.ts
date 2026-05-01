/**
 * /guild Namespace — per-Guild Update-Stream.
 *
 * Routing:
 *  Client emittet 'join' { guildId } -> Server prueft Owner-/Permission-Status
 *  und stuft den Socket in den Room `g:<guildId>` ein. Ein Socket darf
 *  in mehreren Rooms parallel sitzen (bei mehreren Owner-Guilds).
 *
 * Auth-Modell:
 *  - Eingeloggt (Session vorhanden) ist Pflicht.
 *  - Pro Join: Owner-Bypass via Bot-Cache, sonst Permission-Grant lookup.
 *  - Wer keinen Scope hat, bekommt 'join.error' und KEIN Room-Beitritt.
 */

import type { Server as IOServer } from 'socket.io';
import prisma from '../../database/prisma';
import { logger } from '../../utils/logger';
import { tryGetDashboardClient } from '../clientRegistry';
import type { SocketSessionShape } from './index';

interface JoinPayload {
  guildId?: unknown;
}

function isSnowflake(s: unknown): s is string {
  return typeof s === 'string' && /^[0-9]{17,20}$/.test(s);
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
    const req = socket.request as { session?: SocketSessionShape };
    const session = req.session as SocketSessionShape;
    const userDiscordId = session.discordId!;
    logger.debug(`/guild verbunden: ${socket.id} (user=${userDiscordId})`);

    socket.on('join', async (payload: JoinPayload) => {
      const gid = payload?.guildId;
      if (!isSnowflake(gid)) {
        socket.emit('join.error', { error: 'guildId ungueltig' });
        return;
      }
      try {
        const client = tryGetDashboardClient();
        const guild = client?.guilds.cache.get(gid);
        const isOwner = guild?.ownerId === userDiscordId;

        let allowed = isOwner;
        if (!allowed) {
          const grant = await prisma.guildPermissionGrant.findUnique({
            where: { guildId_userDiscordId: { guildId: gid, userDiscordId } },
          });
          allowed = !!grant && Array.isArray(grant.permissions) && grant.permissions.length > 0;
        }
        if (!allowed) {
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

    socket.on('leave', async (payload: JoinPayload) => {
      const gid = payload?.guildId;
      if (!isSnowflake(gid)) return;
      await socket.leave(`g:${gid}`);
      socket.emit('leave.ok', { guildId: gid });
    });

    socket.on('disconnect', reason => {
      logger.debug(`/guild getrennt: ${socket.id} (${reason})`);
    });
  });
}
