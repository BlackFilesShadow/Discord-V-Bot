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
  actorName: string | null;
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

function latestPerGameId<T extends { id: string; actorGameId: string | null; sourceByteStart: bigint }>(events: T[]): Map<string, T> {
  const latest = new Map<string, T>();
  for (const event of [...events].sort(newestFirst)) {
    const gameId = event.actorGameId?.trim();
    if (!gameId || latest.has(gameId)) continue;
    latest.set(gameId, event);
  }
  return latest;
}

/**
 * Live-Roster-Wahrheit innerhalb der aktuellen ADM-Datei:
 *
 * 1. Ein aktuelles CONNECT ist Online-Beleg.
 * 2. Ein bare PLAYER_POSITION aus PluginAdminLog.PlayerList() ist ebenfalls
 *    direkter Online-Beleg und kann deshalb bereits verbundene Spieler nach
 *    einem V2-Baseline-Start sicher einsaeen.
 * 3. Ein neueres DISCONNECT schlaegt aeltere Connect-/PlayerList-Evidenz.
 *
 * Historische PlayerSession.status=OPEN-Zeilen bleiben absichtlich keine
 * Online-Wahrheit. Es werden ausschliesslich Ereignisse derselben aktuellen
 * ADM-Datei miteinander verglichen.
 */
export function resolveOnlinePresence(
  events: PlayerPresenceEvent[],
  positions: PlayerPositionEvent[] = [],
): OnlinePresence[] {
  const latestPresence = latestPerGameId(events);
  const latestPosition = latestPerGameId(positions);
  const gameIds = new Set([...latestPresence.keys(), ...latestPosition.keys()]);
  const online: OnlinePresence[] = [];

  for (const gameId of gameIds) {
    const presence = latestPresence.get(gameId);
    const position = latestPosition.get(gameId);

    // A newer disconnect is authoritative. If a later periodic PlayerList line
    // exists, that later line proves the player is online again even if the
    // corresponding reconnect line was outside the ingested baseline window.
    if (presence?.eventType === 'PLAYER_DISCONNECTED'
      && (!position || presence.sourceByteStart > position.sourceByteStart)) {
      continue;
    }

    if (!presence && !position) continue;
    if (presence?.eventType !== 'PLAYER_CONNECTED' && !position) continue;

    const playerName = (
      position?.actorName?.trim()
      || presence?.actorName?.trim()
      || 'Unbekannt'
    );
    const connectedByteStart = presence?.eventType === 'PLAYER_CONNECTED'
      ? presence.sourceByteStart
      : position!.sourceByteStart;

    online.push({ gameId, playerName, connectedByteStart });
  }

  return online.sort((a, b) => a.gameId.localeCompare(b.gameId));
}

/**
 * Eine Position darf nur aus derselben aktuellen ADM-Datei und nach dem
 * aktuellen Connect bzw. dem ersten sicheren PlayerList-Online-Beleg stammen.
 * Dadurch kann weder ein Reconnect noch ein Server-Neustart alte Koordinaten
 * in die Online List uebernehmen.
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
