import type { PlayerListEntry } from './playerListEmbed';

export type PresenceEventType = 'PLAYER_CONNECTED' | 'PLAYER_DISCONNECTED';

export interface PlayerPresenceEvent {
  id: string;
  eventType: PresenceEventType;
  actorGameId: string | null;
  actorName: string | null;
  sourceByteStart: bigint;
}

export interface PlayerPositionEvent {
  id: string;
  actorGameId: string | null;
  actorPosition: string | null;
  sourceByteStart: bigint;
}

export interface OnlinePresence {
  gameId: string;
  playerName: string;
  connectedByteStart: bigint;
}

function newestFirst<T extends { id: string; sourceByteStart: bigint }>(a: T, b: T): number {
  if (a.sourceByteStart !== b.sourceByteStart) return a.sourceByteStart > b.sourceByteStart ? -1 : 1;
  return b.id.localeCompare(a.id);
}

/**
 * Live-Roster-Wahrheit: pro Game-ID entscheidet ausschliesslich das neueste
 * CONNECT/DISCONNECT-Ereignis der aktuellen ADM-Datei. Historische
 * PlayerSession.status=OPEN-Zeilen sind absichtlich keine Online-Wahrheit.
 */
export function resolveOnlinePresence(events: PlayerPresenceEvent[]): OnlinePresence[] {
  const latest = new Map<string, PlayerPresenceEvent>();
  for (const event of [...events].sort(newestFirst)) {
    const gameId = event.actorGameId?.trim();
    if (!gameId || latest.has(gameId)) continue;
    latest.set(gameId, event);
  }

  const online: OnlinePresence[] = [];
  for (const [gameId, event] of latest) {
    if (event.eventType !== 'PLAYER_CONNECTED') continue;
    online.push({
      gameId,
      playerName: event.actorName?.trim() || 'Unbekannt',
      connectedByteStart: event.sourceByteStart,
    });
  }
  return online;
}

/**
 * Eine Position darf nur aus derselben aktuellen ADM-Datei und nach dem
 * aktuellen Connect stammen. Dadurch kann weder ein Reconnect noch ein
 * Server-Neustart alte Koordinaten in die Online List uebernehmen.
 */
export function attachCurrentPositions(
  online: OnlinePresence[],
  positions: PlayerPositionEvent[],
): PlayerListEntry[] {
  const latestPosition = new Map<string, PlayerPositionEvent>();
  const byGameId = new Map(online.map(player => [player.gameId, player]));

  for (const event of [...positions].sort(newestFirst)) {
    const gameId = event.actorGameId?.trim();
    if (!gameId || latestPosition.has(gameId)) continue;
    const player = byGameId.get(gameId);
    if (!player || event.sourceByteStart < player.connectedByteStart) continue;
    latestPosition.set(gameId, event);
  }

  return online.map(player => ({
    gameId: player.gameId,
    playerName: player.playerName,
    position: latestPosition.get(player.gameId)?.actorPosition?.trim() || null,
  }));
}
