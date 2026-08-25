import fs from 'node:fs';
import path from 'node:path';
import {
  attachCurrentPositions,
  resolveOnlinePresence,
  type PlayerPositionEvent,
  type PlayerPresenceEvent,
} from '../../src/modules/gameplayFeeds/playerListRoster';

function presence(
  id: string,
  eventType: 'PLAYER_CONNECTED' | 'PLAYER_DISCONNECTED',
  gameId: string,
  byte: number,
  name = gameId,
): PlayerPresenceEvent {
  return {
    id,
    eventType,
    actorGameId: gameId,
    actorName: name,
    sourceByteStart: BigInt(byte),
  };
}

function position(id: string, gameId: string, byte: number, value: string): PlayerPositionEvent {
  return {
    id,
    actorGameId: gameId,
    actorPosition: value,
    sourceByteStart: BigInt(byte),
  };
}

describe('Online List live roster truth', () => {
  it('does not resurrect an older OPEN session after a newer disconnect', () => {
    const online = resolveOnlinePresence([
      presence('old-connect', 'PLAYER_CONNECTED', 'phantom', 10, 'Phantom'),
      presence('new-connect', 'PLAYER_CONNECTED', 'phantom', 20, 'Phantom'),
      presence('new-disconnect', 'PLAYER_DISCONNECTED', 'phantom', 30, 'Phantom'),
      presence('solo-connect', 'PLAYER_CONNECTED', 'solo', 40, 'Solo'),
    ]);

    expect(online).toEqual([
      expect.objectContaining({ gameId: 'solo', playerName: 'Solo', connectedByteStart: 40n }),
    ]);
  });

  it('uses the newest presence event per player regardless of input order', () => {
    const online = resolveOnlinePresence([
      presence('dc-b', 'PLAYER_DISCONNECTED', 'b', 80, 'Bravo'),
      presence('c-a', 'PLAYER_CONNECTED', 'a', 100, 'Alpha'),
      presence('c-b', 'PLAYER_CONNECTED', 'b', 50, 'Bravo'),
      presence('old-a', 'PLAYER_DISCONNECTED', 'a', 20, 'Alpha'),
    ]);

    expect(online.map(player => player.gameId)).toEqual(['a']);
  });

  it('never carries a position from before the current reconnect', () => {
    const online = resolveOnlinePresence([
      presence('connect', 'PLAYER_CONNECTED', 'solo', 100, 'Solo'),
    ]);
    const entries = attachCurrentPositions(online, [
      position('old-pos', 'solo', 90, '1,2,3'),
    ]);
    expect(entries).toEqual([{ gameId: 'solo', playerName: 'Solo', position: null }]);
  });

  it('uses the newest position after the current connect', () => {
    const online = resolveOnlinePresence([
      presence('connect', 'PLAYER_CONNECTED', 'solo', 100, 'Solo'),
    ]);
    const entries = attachCurrentPositions(online, [
      position('p1', 'solo', 110, '10,20,0'),
      position('p2', 'solo', 150, '50,60,0'),
    ]);
    expect(entries).toEqual([{ gameId: 'solo', playerName: 'Solo', position: '50,60,0' }]);
  });

  it('runtime scopes live membership to the current ADM source and no longer reads OPEN PlayerSession rows', () => {
    const runtime = fs.readFileSync(
      path.join(process.cwd(), 'src/modules/gameplayFeeds/runtime.ts'),
      'utf8',
    );
    const rosterSection = runtime
      .split('async function currentPlayerList')[1]
      .split('async function processPlayerListConfig')[0];

    expect(rosterSection).toContain('admSourceCursor.findFirst');
    expect(rosterSection).toContain('sourceFile: latestCursor.fileIdentity');
    expect(rosterSection).toContain('AdmEventType.PLAYER_DISCONNECTED');
    expect(rosterSection).not.toContain('playerSession.findMany');
  });
});
