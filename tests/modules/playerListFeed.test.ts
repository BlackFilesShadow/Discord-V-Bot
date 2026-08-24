process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

import { buildPlayerListEmbeds, playerListStateHash } from '../../src/modules/gameplayFeeds/playerListEmbed';

describe('Player List Feed embed and change detection', () => {
  const entries = [
    { gameId: 'guid-b', playerName: 'Bravo', position: null },
    { gameId: 'guid-a', playerName: 'Alpha', position: '100,200,10' },
  ];

  it('renders a valid empty state for zero players', () => {
    const json = buildPlayerListEmbeds({
      serverAlias: 'Empty Server', entries: [], showCoordinates: false, embedColor: '#2563eb',
    })[0].toJSON();
    expect(json.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Online', value: '0' }),
      expect.objectContaining({ name: 'Spieler', value: expect.stringMatching(/keine Spieler/i) }),
    ]));
  });

  it('keeps a single player visible with and without a known coordinate', () => {
    const without = buildPlayerListEmbeds({
      serverAlias: 'Server',
      entries: [{ gameId: 'one', playerName: 'Solo', position: null }],
      showCoordinates: true,
      embedColor: '#2563eb',
    })[0].toJSON();
    const withPosition = buildPlayerListEmbeds({
      serverAlias: 'Server',
      entries: [{ gameId: 'one', playerName: 'Solo', position: '50,60,0' }],
      showCoordinates: true,
      embedColor: '#2563eb',
    })[0].toJSON();
    expect(without.fields?.find(field => field.name === 'Spieler')?.value).toMatch(/Solo.*Position unbekannt/s);
    expect(withPosition.fields?.find(field => field.name === 'Spieler')?.value).toMatch(/Solo.*50,60/s);
  });

  it('shows server alias, online count, names, map link and explicit unknown position', () => {
    const json = buildPlayerListEmbeds({
      serverAlias: 'Chernarus #1', entries, showCoordinates: true, embedColor: '#2563eb',
    })[0].toJSON();
    expect(json.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Server', value: 'Chernarus #1' }),
      expect.objectContaining({ name: 'Online', value: '2' }),
      expect.objectContaining({
        name: 'Spieler',
        value: expect.stringMatching(/Alpha.*izurvive\.com.*Bravo.*Position unbekannt/s),
      }),
    ]));
  });

  it('omits every coordinate when the toggle is off', () => {
    const fields = buildPlayerListEmbeds({
      serverAlias: 'Server', entries, showCoordinates: false, embedColor: '#2563eb',
    })[0].toJSON().fields ?? [];
    const value = fields.map(field => field.value).join('\n');
    expect(value).toContain('Alpha');
    expect(value).not.toMatch(/100,200|Position unbekannt|izurvive/i);
  });

  it('does not treat pure position movement as a list change', () => {
    const moved = entries.map(entry => ({ ...entry, position: '900,900,0' }));
    expect(playerListStateHash(entries, true)).toBe(playerListStateHash(moved, true));
    expect(playerListStateHash(entries, false)).not.toBe(playerListStateHash(entries, true));
  });

  it('changes deterministically on join, disconnect and rename', () => {
    const base = playerListStateHash(entries, true);
    expect(playerListStateHash(entries.slice(0, 1), true)).not.toBe(base);
    expect(playerListStateHash([...entries, { gameId: 'guid-c', playerName: 'Charlie', position: null }], true)).not.toBe(base);
    expect(playerListStateHash(entries.map(entry => entry.gameId === 'guid-a' ? { ...entry, playerName: 'Alpha2' } : entry), true)).not.toBe(base);
  });

  it('coalesces multiple rapid joins/disconnects into the final membership hash', () => {
    const joined = Array.from({ length: 20 }, (_, index) => ({
      gameId: `rapid-${index}`,
      playerName: `Rapid${index}`,
      position: null,
    }));
    const afterDisconnects = joined.slice(10);
    expect(playerListStateHash(joined, false)).not.toBe(playerListStateHash(afterDisconnects, false));
    expect(playerListStateHash(afterDisconnects, false)).toBe(playerListStateHash([...afterDisconnects].reverse(), false));
  });

  it('stays inside Discord embed/message limits for a large server', () => {
    const many = Array.from({ length: 100 }, (_, index) => ({
      gameId: `guid-${index}`,
      playerName: `Player_${String(index).padStart(3, '0')}`,
      position: `${index * 10},${index * 20},0`,
    }));
    const embeds = buildPlayerListEmbeds({
      serverAlias: 'Large Server', entries: many, showCoordinates: true, embedColor: '#2563eb',
    });
    expect(embeds.length).toBeLessThanOrEqual(10);
    for (const embed of embeds) {
      const json = embed.toJSON();
      expect(json.fields?.length ?? 0).toBeLessThanOrEqual(25);
      for (const field of json.fields ?? []) expect(field.value.length).toBeLessThanOrEqual(1024);
    }
  });
});
