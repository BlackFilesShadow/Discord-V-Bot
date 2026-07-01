/**
 * Typed Emit-Helpers fuer Sockets.
 *
 * REST-Routen importieren `emitGuildEvent`/`emitDevLog` und feuern damit
 * Updates in die jeweiligen Namespaces. Wenn Socket.IO nicht initialisiert
 * ist (z.B. in Tests), werden die Calls stillschweigend verworfen.
 */

import type { Server as IOServer } from 'socket.io';

let io: IOServer | null = null;

export function setIo(instance: IOServer): void {
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
  | { type: 'economy.tx'; payload: { guildId: string; userDiscordId: string; type: string } }
  | { type: 'casino.round'; payload: { guildId: string; gameType: string; payout: string } }
  | { type: 'faction.changed'; payload: { guildId: string; factionId: string } }
  | { type: 'settings.changed'; payload: { guildId: string; slotId: string } }
  | { type: 'tickets.changed'; payload: { guildId: string; templateId?: string } }
  | { type: 'killfeed.changed'; payload: { guildId: string; configId?: string } }
  | { type: 'killfeed.event'; payload: { guildId: string; configId: string; category: string; victimName: string; shooterName?: string; weapon?: string; distance?: number; occurredAt: string } }
  | { type: 'welcome.changed'; payload: { guildId: string } }
  | { type: 'embed.changed'; payload: { guildId: string; embedId?: string } }
  | { type: 'reactionEmbed.changed'; payload: { guildId: string; menuId?: string } }
  | { type: 'feed.changed'; payload: { guildId: string; feedId?: string } }
  | { type: 'translatedPost.changed'; payload: { guildId: string; postId?: string } };

/**
 * Sendet Event an alle Clients im Room des betreffenden Guild-Namespace.
 */
export function emitGuildEvent(guildId: string, event: GuildEvent): void {
  if (!io) return;
  io.of('/guild').to(`g:${guildId}`).emit(event.type, event.payload);
}

export interface DevLogLine {
  ts: number;
  level: string;
  message: string;
  meta?: Record<string, unknown>;
}

/**
 * Pusht eine Log-Zeile in den /dev-Namespace.
 */
export function emitDevLog(line: DevLogLine): void {
  if (!io) return;
  io.of('/dev').emit('log', line);
}
