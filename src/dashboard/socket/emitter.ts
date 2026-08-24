/**
 * Typed Emit-Helpers fuer Sockets.
 *
 * Guild-weite UI-Aenderungen gehen in `g:<guildId>`. Gameplay-/Server-Events
 * gehen zusaetzlich in einen engeren Room `gs:<guildId>:<nitradoConnId>`, damit
 * Clients mit mehreren Gameservern niemals Ereignisse eines anderen Slots
 * vermischen muessen.
 */

import type { Server as IOServer } from 'socket.io';
import { redactAuditDetails } from '../../utils/auditRedaction';

let io: IOServer | null = null;

export function setIo(instance: IOServer | null): void {
  io = instance;
}

/** Liefert die laufende Socket.IO-Instanz oder null (z. B. in Tests). */
export function getIo(): IOServer | null {
  return io;
}

export type GuildEvent =
  | {
      type: 'whitelist.changed';
      payload: {
        guildId: string;
        entryId?: string;
        action: 'added' | 'removed' | 'requested' | 'decided' | 'remove_pending' | 'synced';
      };
    }
  | { type: 'nitrado.job.updated'; payload: { guildId: string; jobId: string; status: string } }
  | { type: 'permissions.updated'; payload: { guildId: string; userDiscordId?: string; roleDiscordId?: string } }
  | { type: 'economy.tx'; payload: { guildId: string; nitradoConnId: string; userDiscordId: string; type: string } }
  | {
      type: 'casino.round';
      payload: {
        guildId: string;
        nitradoConnId: string | null;
        gameType: string;
        payout: string;
        outcome?: 'WON' | 'LOST' | 'DRAW';
      };
    }
  | { type: 'faction.changed'; payload: { guildId: string; factionId: string } }
  | { type: 'settings.changed'; payload: { guildId: string; slotId: string } }
  | { type: 'tickets.changed'; payload: { guildId: string; templateId?: string } }
  | { type: 'killfeed.changed'; payload: { guildId: string; configId?: string; kind?: 'DEATH' | 'BUILD' | 'PLAYER_LIST' } }
  | { type: 'killfeed.event'; payload: { guildId: string; configId: string; category: string; victimName: string; shooterName?: string; weapon?: string; distance?: number; occurredAt: string } }
  | { type: 'welcome.changed'; payload: { guildId: string } }
  | { type: 'goodbye.changed'; payload: { guildId: string } }
  | { type: 'embed.changed'; payload: { guildId: string; embedId?: string } }
  | { type: 'reactionEmbed.changed'; payload: { guildId: string; menuId?: string } }
  | { type: 'feed.changed'; payload: { guildId: string; feedId?: string } }
  | { type: 'translatedPost.changed'; payload: { guildId: string; postId?: string } };

export interface ServerGameplayEventPayload {
  guildId: string;
  nitradoConnId: string;
  eventId?: string;
  source: 'ADM_V1' | 'ADM_V2';
  eventType: string;
  occurredAt: string | null;
  actorName?: string | null;
  targetName?: string | null;
  weapon?: string | null;
  distance?: number | null;
  actorPosition?: string | null;
  targetPosition?: string | null;
}

export function serverRoomName(guildId: string, nitradoConnId: string): string {
  return `gs:${guildId}:${nitradoConnId}`;
}

export function emitGuildEvent(guildId: string, event: GuildEvent): void {
  if (!io) return;
  io.of('/guild').to(`g:${guildId}`).emit(event.type, event.payload);
}

export function emitServerGameplayEvent(event: ServerGameplayEventPayload): void {
  if (!io) return;
  io.of('/guild')
    .to(serverRoomName(event.guildId, event.nitradoConnId))
    .emit('server.gameplay.event', event);
}

export interface DevLogLine {
  ts: number;
  level: string;
  message: string;
  meta?: Record<string, unknown>;
}

const DEV_LOG_MAX_DEPTH = 8;
const DEV_LOG_TRUNCATED = '[TRUNCATED]';
const DEV_LOG_CIRCULAR = '[CIRCULAR]';
const DEV_LOG_UNSUPPORTED = '[UNSUPPORTED]';
const DEV_LOG_LEVELS = new Set(['error', 'warn', 'info', 'http', 'debug', 'verbose', 'silly']);

function normalizeDevLogValue(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (depth > DEV_LOG_MAX_DEPTH) return DEV_LOG_TRUNCATED;
  if (value === null || value === undefined) return value;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'symbol' || typeof value === 'function') return DEV_LOG_UNSUPPORTED;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return normalizeDevLogValue({ name: value.name, message: value.message, stack: value.stack }, seen, depth + 1);
  }
  if (typeof value !== 'object') return DEV_LOG_UNSUPPORTED;
  if (seen.has(value)) return DEV_LOG_CIRCULAR;

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map(item => normalizeDevLogValue(item, seen, depth + 1));
    }
    let entries: Array<[string, unknown]>;
    try {
      entries = Object.entries(value as Record<string, unknown>);
    } catch {
      return DEV_LOG_TRUNCATED;
    }
    const out: Record<string, unknown> = {};
    for (const [key, child] of entries) {
      try {
        out[key] = normalizeDevLogValue(child, seen, depth + 1);
      } catch {
        out[key] = DEV_LOG_TRUNCATED;
      }
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

export function sanitizeDevLogLine(line: DevLogLine): DevLogLine {
  const normalized = normalizeDevLogValue(
    { level: line.level, message: line.message, meta: line.meta },
    new WeakSet<object>(),
    0,
  ) as { level?: unknown; message?: unknown; meta?: unknown };
  const redacted = redactAuditDetails(normalized) as { level?: unknown; message?: unknown; meta?: unknown };
  const candidateLevel = typeof redacted.level === 'string' ? redacted.level : 'info';

  return {
    ts: Number.isFinite(line.ts) ? line.ts : Date.now(),
    level: DEV_LOG_LEVELS.has(candidateLevel) ? candidateLevel : 'info',
    message: typeof redacted.message === 'string' ? redacted.message : '[REDACTED]',
    meta: redacted.meta && typeof redacted.meta === 'object' && !Array.isArray(redacted.meta)
      ? redacted.meta as Record<string, unknown>
      : undefined,
  };
}

export function emitDevLog(line: DevLogLine): void {
  if (!io) return;
  io.of('/dev').emit('log', sanitizeDevLogLine(line));
}
