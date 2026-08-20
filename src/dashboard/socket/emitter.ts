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
  | { type: 'killfeed.changed'; payload: { guildId: string; configId?: string; kind?: 'DEATH' | 'BUILD' } }
  | { type: 'killfeed.event'; payload: { guildId: string; configId: string; category: string; victimName: string; shooterName?: string; weapon?: string; distance?: number; occurredAt: string } }
  | { type: 'welcome.changed'; payload: { guildId: string } }
  | { type: 'goodbye.changed'; payload: { guildId: string } }
  | { type: 'embed.changed'; payload: { guildId: string; embedId?: string } }
  | { type: 'reactionEmbed.changed'; payload: { guildId: string; menuId?: string } }
  | { type: 'feed.changed'; payload: { guildId: string; feedId?: string } }
  | { type: 'translatedPost.changed'; payload: { guildId: string; postId?: string } };

/**
 * Kanonisches, transportsicheres Gameplay-Event fuer den Server-internen Feed.
 * `eventId` ist optional, weil der alte Killfeed vor AdmEvent-V2 eigene IDs
 * verwendet. Der Scope ist dagegen IMMER vollstaendig.
 */
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

/** Sendet ein guild-weites UI-Event. */
export function emitGuildEvent(guildId: string, event: GuildEvent): void {
  if (!io) return;
  io.of('/guild').to(`g:${guildId}`).emit(event.type, event.payload);
}

/**
 * Sendet Gameplay nur an Clients, die explizit genau diesem Gameserver-Room
 * beigetreten sind. Kein Fallback auf den Guild-Room: fail-closed gegen
 * versehentliche Cross-Server-Datenvermischung.
 */
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

/**
 * Normalisiert beliebige Winston-Metadaten auf eine endliche JSON-Struktur.
 * Dadurch koennen Error-/BigInt-/zyklische Werte den Security-Redactor oder
 * den Socket-Broadcast nicht aushebeln bzw. durch Exceptions umgehen.
 */
function normalizeDevLogValue(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (depth > DEV_LOG_MAX_DEPTH) return DEV_LOG_TRUNCATED;
  if (value === null || value === undefined) return value;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'symbol' || typeof value === 'function') return String(value);
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return normalizeDevLogValue({ name: value.name, message: value.message, stack: value.stack }, seen, depth + 1);
  }
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return DEV_LOG_CIRCULAR;

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map(item => normalizeDevLogValue(item, seen, depth + 1));
    }
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
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

/**
 * Kanonische fail-closed Redaction fuer den DEV-Live-Transport.
 * Dieselbe Policy wie Audit/DB-Reads schuetzt freie Texte UND verschachtelte
 * Metadaten, bevor irgendetwas den privilegierten Socket-Namespace verlaesst.
 */
export function sanitizeDevLogLine(line: DevLogLine): DevLogLine {
  const normalized = normalizeDevLogValue(
    { message: line.message, meta: line.meta },
    new WeakSet<object>(),
    0,
  ) as { message?: unknown; meta?: unknown };
  const redacted = redactAuditDetails(normalized) as { message?: unknown; meta?: unknown };

  return {
    ts: Number.isFinite(line.ts) ? line.ts : Date.now(),
    level: typeof line.level === 'string' ? line.level.slice(0, 32) : 'info',
    message: typeof redacted.message === 'string' ? redacted.message : '[REDACTED]',
    meta: redacted.meta && typeof redacted.meta === 'object' && !Array.isArray(redacted.meta)
      ? redacted.meta as Record<string, unknown>
      : undefined,
  };
}

/** Pusht ausschliesslich redigierte Log-Zeilen in den /dev-Namespace. */
export function emitDevLog(line: DevLogLine): void {
  if (!io) return;
  io.of('/dev').emit('log', sanitizeDevLogLine(line));
}
