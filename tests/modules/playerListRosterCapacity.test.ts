import {
  attachCurrentPositions,
  resolveOnlinePresence,
  type PlayerPositionEvent,
  type PlayerPresenceEvent,
} from '../../src/modules/gameplayFeeds/playerListRoster';

function newestPerGameId<T extends { actorGameId: string | null; sourceByteStart: bigint; id: string }>(rows: T[]): T[] {
  const sorted = [...rows].sort((a, b) => {
    if (a.actorGameId !== b.actorGameId) return String(a.actorGameId).localeCompare(String(b.actorGameId));
    if (a.sourceByteStart !== b.sourceByteStart) return a.sourceByteStart > b.sourceByteStart ? -1 : 1;
    return b.id.localeCompare(a.id);
  });
  const seen = new Set<string>();
  return sorted.filter(row => {
    if (!row.actorGameId || seen.has(row.actorGameId)) return false;
    seen.add(row.actorGameId);
    return true;
  });
}

describe('PLAYER_LIST 4000-player bounded evidence', () => {
  it('latest-per-player evidence is semantically equivalent to full history', () => {
    const presence: PlayerPresenceEvent[] = [];
    const positions: PlayerPositionEvent[] = [];
    for (let player = 0; player < 4000; player += 1) {
      const gameId = `game-${player}`;
      presence.push({ id: `c-${player}`, eventType: 'PLAYER_CONNECTED', actorGameId: gameId, actorName: `Player ${player}`, sourceByteStart: BigInt(player * 1000) });
      for (let sample = 1; sample <= 8; sample += 1) {
        positions.push({ id: `p-${player}-${sample}`, actorGameId: gameId, actorName: `Player ${player}`, actorPosition: `${player},${sample},10`, sourceByteStart: BigInt(player * 1000 + sample) });
      }
    }
    // Exercise disconnect precedence for a subset as well.
    for (let player = 0; player < 4000; player += 37) {
      presence.push({ id: `d-${player}`, eventType: 'PLAYER_DISCONNECTED', actorGameId: `game-${player}`, actorName: `Player ${player}`, sourceByteStart: BigInt(player * 1000 + 20) });
    }

    const full = attachCurrentPositions(resolveOnlinePresence(presence, positions), positions);
    const boundedPresence = newestPerGameId(presence) as PlayerPresenceEvent[];
    const boundedPositions = newestPerGameId(positions) as PlayerPositionEvent[];
    const bounded = attachCurrentPositions(resolveOnlinePresence(boundedPresence, boundedPositions), boundedPositions);

    expect(bounded).toEqual(full);
    expect(boundedPresence.length).toBeLessThanOrEqual(4000);
    expect(boundedPositions).toHaveLength(4000);
    expect(positions).toHaveLength(32000);
  });
});
