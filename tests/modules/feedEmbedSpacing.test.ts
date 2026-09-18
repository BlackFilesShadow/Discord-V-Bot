process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

import { buildGameplayFeedEmbed } from '../../src/modules/gameplayFeeds/embedBuilder';
import { buildPlayerListEmbeds } from '../../src/modules/gameplayFeeds/playerListEmbed';
import type { GameplayFeedView } from '../../src/modules/gameplayFeeds/types';

function baseView(overrides: Partial<GameplayFeedView> = {}): GameplayFeedView {
  return {
    eventId: 'event-1',
    kind: 'KILL',
    category: 'PVP',
    eventType: 'PLAYER_KILLED',
    occurredAt: new Date('2026-09-18T12:00:00.000Z'),
    actorName: 'Victim',
    targetName: 'Killer',
    objectType: null,
    toolOrWeapon: 'M4-A1',
    distanceMeters: 42.5,
    actorPosition: null,
    targetPosition: null,
    pvpHit: null,
    ...overrides,
  };
}

describe('approved gameplay feed spacing', () => {
  it('keeps the V-Kill blocks separated exactly as approved', () => {
    const description = buildGameplayFeedEmbed(baseView(), '#dc2626', 'Chernarus Main').toJSON().description;
    expect(description).toBe([
      '**💀 V-Kill Report**',
      '',
      '**Killer:** Killer',
      '',
      '**Opfer:** Victim',
      '',
      '**Waffe:** M4-A1',
      '**Distanz:** 42.5 m',
    ].join('\n'));
  });

  it('keeps regular ADM feed fields compact below one blank line after the heading', () => {
    const description = buildGameplayFeedEmbed(baseView({
      kind: 'DEATH',
      category: 'SUICIDE',
      eventType: 'PLAYER_SUICIDE',
      actorName: 'Solo',
      targetName: null,
      distanceMeters: null,
      toolOrWeapon: 'IJ-70',
    }), '#dc2626', 'Chernarus Main').toJSON().description ?? '';

    expect(description).toMatch(/^\*\*🩸 Self Kill Report\*\*\n\n\*\*Spieler:\*\* Solo\n\*\*Waffe:\*\* IJ-70/);
    expect(description).not.toContain('Self Kill Report**\n\n\n');
  });

  it('keeps the online-list heading separated from the roster by one blank line', () => {
    const description = buildPlayerListEmbeds({
      serverAlias: 'Chernarus Main',
      entries: [{ gameId: 'guid-1', playerName: 'Alpha', position: null }],
      showCoordinates: false,
      embedColor: '#2563eb',
    })[0].toJSON().description;

    expect(description).toBe('**🌐 • Online List · 1 Players**\n\n• Alpha');
  });
});
