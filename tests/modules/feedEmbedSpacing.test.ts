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

  const admHeadingCases: Array<[string, Partial<GameplayFeedView>, string]> = [
    ['PVP', { kind: 'KILL', category: 'PVP', eventType: 'PLAYER_KILLED' }, '💀 V-Kill Report'],
    ['SUICIDE', { kind: 'DEATH', category: 'SUICIDE', eventType: 'PLAYER_SUICIDE' }, '🩸 Self Kill Report'],
    ['NPC', { kind: 'DEATH', category: 'NPC', eventType: 'NPC_KILL' }, '☣️ Wild Kill Report'],
    ['VEHICLE', { kind: 'DEATH', category: 'VEHICLE', eventType: 'VEHICLE_DEATH' }, '💥 Crash Kill Report'],
    ['OTHER', { kind: 'DEATH', category: 'OTHER', eventType: 'PLAYER_DIED' }, '☠️ Death Report'],
    ['PLACEMENT', { kind: 'PLACEMENT', category: 'PLACEMENT', eventType: 'PLACEMENT' }, '📦 Placement Report'],
    ['BUILD', { kind: 'BUILD', category: 'BUILD', eventType: 'BUILD' }, '🔨 Build Report'],
    ['DISMANTLE', { kind: 'BUILD', category: 'DISMANTLE', eventType: 'DISMANTLE' }, '🔧 Dismantle Report'],
    ['DESTROY', { kind: 'BUILD', category: 'DESTROY', eventType: 'DESTROY' }, '💥 Destruction Report'],
    ['RAISED', { kind: 'FLAG', category: 'RAISED', eventType: 'FLAG_RAISED' }, '🚩 Flagge hochgezogen'],
    ['LOWERED', { kind: 'FLAG', category: 'LOWERED', eventType: 'FLAG_LOWERED' }, '🏳️ Flagge heruntergelassen'],
  ];

  it.each(admHeadingCases)('%s keeps the embed name exactly one blank line above its content', (_category, overrides, title) => {
    const description = buildGameplayFeedEmbed(baseView({
      ...overrides,
      actorName: 'Spacing Player',
      targetName: overrides.category === 'NPC' ? 'Animal_CanisLupus' : 'Target',
      objectType: overrides.kind === 'FLAG' ? 'Flag_RSTA' : 'Fence',
      toolOrWeapon: 'M4-A1',
      distanceMeters: 42.5,
      actorPosition: '100, 20, 200',
      targetPosition: '101, 21, 201',
    }), '#dc2626', 'Chernarus Main').toJSON().description ?? '';

    expect(description.startsWith(`**${title}**\n\n`)).toBe(true);
    expect(description.startsWith(`**${title}**\n\n\n`)).toBe(false);
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

  it('keeps flag action, flag data and positions in the approved separated blocks', () => {
    const description = buildGameplayFeedEmbed(baseView({
      kind: 'FLAG',
      category: 'RAISED',
      eventType: 'FLAG_RAISED',
      actorName: 'Flag Player',
      targetName: 'TerritoryFlag',
      objectType: 'Flag_RSTA',
      toolOrWeapon: null,
      distanceMeters: null,
      actorPosition: '100, 20, 200',
      targetPosition: '101, 21, 201',
    }), '#22c55e', 'Chernarus Main').toJSON().description ?? '';

    expect(description).toContain('**🚩 Flagge hochgezogen**\n\n**Aktion:** Hochgezogen\n**Spieler:** Flag Player');
    expect(description).toContain('**Spieler:** Flag Player\n\n**Flagge**\nRSTA\nClassname: `Flag_RSTA`');
    expect(description).toContain('**Flagge**\nRSTA\nClassname: `Flag_RSTA`\n\n**Flaggen-Position**');
    expect(description).toContain('**Flaggen-Position**\nX: 101 • Z: 201\nHöhe: 21\n\n**Spieler-Position**');
    expect(description).toContain('**Spieler-Position**\nX: 100 • Z: 200\nHöhe: 20\n\n**Ereigniszeit:**');
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
