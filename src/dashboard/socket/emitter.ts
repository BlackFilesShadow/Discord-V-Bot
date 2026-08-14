/**
 * Typed Emit-Helpers fuer Sockets.
 *
 * Guild-weite UI-Aenderungen gehen in `g:<guildId>`. Gameplay-/Server-Events
 * gehen zusaetzlich in einen engeren Room `gs:<guildId>:<nitradoConnId>`, damit
 * Clients mit mehreren Gameservern niemals Ereignisse eines anderen Slots
 * vermischen muessen.
 */

import type { Server as IOServer } from 'socket.io';

let io: IOServer | null = null;

export function setIo(instance: IOServer | null): void {
  io = instance;
}

/** Liefert die laufende Socket.IO-Instanz oder null (z. B. in Tests). */
export function getIo(): IOServer | null {
  return io;
}

export type GuildEvent =
  | { type: 'whitelist.changed'; payload: { guildId: string; entryId?: string; action: 'added' | 'removed' | 'requested' | 'decided' } }
  | { type: 'nitrado.job.updated'; payload: { guildId: string; jobId: string; status: string } }
  | { type: 'permissions.updated'; payload: { guildId: string; userDiscordId?: string; roleDiscordId?: string } }
  | { type: 'economy.tx'; payload: { guildId: string; nitradoConnId: string; userDiscordId: string; type: string } }
  | { type: 'casino.round'; payload: { guildId: string; nitradoConnId: string | null; gameType: string; payout: string } }
  | { type: 'faction.changed'; payload: { guildId: string; factionId: string } }
  | { type: 'settings.changed'; payload: { guildId: string; slotId: string } }
  | { type: 'tickets.changed'; payload: { guildId: string; templateId?: string } }
  | { type: 'killfeed.changed'; payload: { guildId: string; configId?: string; kind?: 'DEATH' | 'BUILD' } }
  | { type: 'killfeed.event'; payload: { guildId: string; configId: string; category: string; victimName: string; shooterName?: string; weapon?: string; distance?: number; occurredAt: string } }
  | { type: 'welcome.changed'; payload: { guildId: string } }
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

/** Pusht eine Log-Zeile in den /dev-Namespace. */
export function emitDevLog(line: DevLogLine): void {
  if (!io) return;
  io.of('/dev').emit('log', line);
}
