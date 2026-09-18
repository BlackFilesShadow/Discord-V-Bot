process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

import { buildPlayerListEmbeds, playerListStateHash } from '../../src/modules/gameplayFeeds/playerListEmbed';

function embedTextLength(json: ReturnType<ReturnType<typeof buildPlayerListEmbeds>[number]['toJSON']>): number {
  let total = 0;
  total += json.title?.length ?? 0;
  total += json.description?.length ?? 0;
  total += json.author?.name?.length ?? 0;
  total += json.footer?.text?.length ?? 0;
  for (const field of json.fields ?? []) total += field.name.length + field.value.length;
  return total;
}

describe('Online List embed and change detection', () => {
  const entries = [
    { gameId: 'guid-b', playerName: 'Bravo', position: null },
    { gameId: 'guid-a', playerName: 'Alpha', position: '100,200,10' },
  ];

  it('renders the approved empty-state spacing for zero players', () => {
    const json = buildPlayerListEmbeds({
      serverAlias: 'Empty Server', entries: [], showCoordinates: false, embedColor: '#2563eb',
    })[0].toJSON();
    expect(json.description).toContain('**🌐 • Online List · 0 Players**\n\nKeine Spieler online.');
    expect(json.footer?.text).toBe('Empty Server');
    expect(json.fields ?? []).toHaveLength(0);
  });

  it('keeps a newly connected player visible without publishing a transient unknown position', () => {
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
    const pendingValue = without.description ?? '';
    expect(pendingValue).toContain('**🌐 • Online List · 1 Players**\n\n• Solo');
    expect(pendingValue).not.toMatch(/Position unbekannt|izurvive/i);
    expect(withPosition.description).toMatch(/Solo.*50,60/s);
  });

  it('shows server alias, online count and only current-session coordinates that are already known', () => {
    const json = buildPlayerListEmbeds({
      serverAlias: 'Chernarus #1', entries, showCoordinates: true, embedColor: '#2563eb',
    })[0].toJSON();
    expect(json.footer?.text).toBe('Chernarus #1');
    expect(json.description).toContain('**🌐 • Online List · 2 Players**\n\n');
    expect(json.description).toMatch(/Alpha.*izurvive\.com.*Bravo/s);
    expect(JSON.stringify(json)).not.toContain('Position unbekannt');
  });

  it('keeps the reference card free of Stand and generic embed timestamps', () => {
    const generatedAt = new Date('2026-08-25T19:15:00.000Z');
    const json = buildPlayerListEmbeds({
      serverAlias: 'Alias Only', entries, showCoordinates: false, embedColor: '#2563eb', generatedAt,
    })[0].toJSON();

    expect(json.footer?.text).toBe('Alias Only');
    expect(json.timestamp).toBeUndefined();
    expect(json.description).not.toContain('Stand');
    expect(JSON.stringify(json)).not.toMatch(/Slot\s*\d+/i);
  });

  it('omits every coordinate when the toggle is off', () => {
    const json = buildPlayerListEmbeds({
      serverAlias: 'Server', entries, showCoordinates: false, embedColor: '#2563eb',
    })[0].toJSON();
    const value = json.description ?? '';
    expect(value).toContain('Alpha');
    expect(value).not.toMatch(/100,200|Position unbekannt|izurvive/i);
  });

  it('updates visible coordinate state when the first current-session position arrives', () => {
    const pending = [{ gameId: 'guid-a', playerName: 'Alpha', position: null }];
    const resolved = [{ gameId: 'guid-a', playerName: 'Alpha', position: '900,900,0' }];
    expect(playerListStateHash(pending, true)).not.toBe(playerListStateHash(resolved, true));
    expect(playerListStateHash(pending, false)).toBe(playerListStateHash(resolved, false));
  });

  it('updates visible coordinate state on movement but ignores movement when coordinates are disabled', () => {
    const moved = entries.map(entry => ({ ...entry, position: '900,900,0' }));
    expect(playerListStateHash(entries, true)).not.toBe(playerListStateHash(moved, true));
    expect(playerListStateHash(entries, false)).toBe(playerListStateHash(moved, false));
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

  it('fits 50 players with coordinates onto a single page before starting a continuation', () => {
    // Explizite Anforderung: bis zu 50 Spieler muessen auf einer Seite Platz
    // finden, bevor eine 2. Seite ("Fortsetzung") entsteht. Vorher erzwang ein
    // zu niedriges FIELD_LIMIT (900 statt nahe am echten 4096-Discord-Limit)
    // schon ab ca. 10 Spielern eine 2. Seite.
    const fifty = Array.from({ length: 50 }, (_, index) => ({
      gameId: `guid-${index}`,
      playerName: `Player_${String(index).padStart(3, '0')}`,
      position: `${10000 + index}.0,${20000 + index}.0,${50 + index}.0`,
    }));
    const embeds = buildPlayerListEmbeds({
      serverAlias: 'Die Chaoten', entries: fifty, showCoordinates: true, embedColor: '#2563eb',
    });
    expect(embeds).toHaveLength(1);
    const json = embeds[0].toJSON();
    expect(json.description).toContain('**🌐 • Online List · 50 Players**\n\n');
    expect(json.description).not.toMatch(/Fortsetzung/);
    expect(json.description).toContain('Player\\_000');
    expect(json.description).toContain('Player\\_049');
  });

  it('drops iZurvive links (keeps plain coordinates) rather than splitting a 50-player roster onto a 2nd page', () => {
    const fifty = Array.from({ length: 50 }, (_, index) => ({
      gameId: `guid-${index}`,
      playerName: `Player_${String(index).padStart(3, '0')}`,
      position: `${10000 + index}.0,${20000 + index}.0,${50 + index}.0`,
    }));
    const json = buildPlayerListEmbeds({
      serverAlias: 'Die Chaoten', entries: fifty, showCoordinates: true, embedColor: '#2563eb',
    })[0].toJSON();
    expect(json.description).not.toMatch(/izurvive/i);
    expect(json.description).toContain('10000.0,20000.0,50.0');
  });

  it('keeps clickable izurvive links for small rosters well under the per-page budget', () => {
    const small = Array.from({ length: 5 }, (_, index) => ({
      gameId: `guid-${index}`,
      playerName: `Player_${index}`,
      position: `${100 + index},${200 + index},${5 + index}`,
    }));
    const json = buildPlayerListEmbeds({
      serverAlias: 'Kleiner Server', entries: small, showCoordinates: true, embedColor: '#2563eb',
    })[0].toJSON();
    expect(json.description).toMatch(/izurvive\.com/i);
  });

  it('keeps a 100-player coordinate list inside the aggregate Discord embed limit', () => {
    const many = Array.from({ length: 100 }, (_, index) => ({
      gameId: `guid-${index}`,
      playerName: `Player_${String(index).padStart(3, '0')}`,
      position: `${index * 10},${index * 20},0`,
    }));
    const embeds = buildPlayerListEmbeds({
      serverAlias: 'Large Server', entries: many, showCoordinates: true, embedColor: '#2563eb',
    });
    expect(embeds.length).toBeLessThanOrEqual(10);
    const json = embeds.map(embed => embed.toJSON());
    for (const item of json) {
      expect(item.fields ?? []).toHaveLength(0);
      expect(item.description?.length ?? 0).toBeLessThanOrEqual(4096);
    }
    expect(json.reduce((sum, item) => sum + embedTextLength(item), 0)).toBeLessThanOrEqual(6000);
    const visible = json.map(item => item.description ?? '').join('\n');
    expect(visible).toContain('Player\\_000');
    expect(visible).toContain('Player\\_099');
  });
});
