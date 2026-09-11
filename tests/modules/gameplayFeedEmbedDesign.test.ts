process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

import { buildGameplayFeedEmbed, placementObjectLabel } from '../../src/modules/gameplayFeeds/embedBuilder';
import type { GameplayFeedView } from '../../src/modules/gameplayFeeds/types';

const SERVER = 'Chernarus Main';
const EVENT_TIME = `<t:${Math.floor(new Date('2026-08-24T20:00:00.000Z').getTime() / 1000)}:F>`;

function view(overrides: Partial<GameplayFeedView>): GameplayFeedView {
  return {
    eventId: 'event-1',
    kind: 'KILL',
    category: 'PVP',
    eventType: 'PLAYER_KILLED',
    occurredAt: new Date('2026-08-24T20:00:00.000Z'),
    actorName: 'Victim',
    targetName: 'Killer',
    objectType: null,
    toolOrWeapon: 'M4-A1',
    distanceMeters: 42.5,
    actorPosition: '100,200,10',
    targetPosition: '110,210,10',
    ...overrides,
  };
}

function descriptionFor(feed: GameplayFeedView): string {
  return buildGameplayFeedEmbed(feed, '#dc2626', SERVER).toJSON().description ?? '';
}

function expectOrder(description: string, labels: string[]): void {
  let previous = -1;
  for (const label of labels) {
    const index = description.indexOf(label);
    expect(index).toBeGreaterThan(previous);
    previous = index;
  }
}

describe('approved V-Bot gameplay feed embed designs', () => {
  it('renders V-Kill Report compactly with Killer before Opfer, inline Pos links and server alias footer', () => {
    const json = buildGameplayFeedEmbed(view({}), '#dc2626', SERVER).toJSON();
    const description = json.description ?? '';
    expect(description).toContain('**💀 V-Kill Report**');
    expectOrder(description, ['**Killer**', '**Opfer**', '**Waffe:**', '**Distanz:**']);
    expect(description).toContain('Killer\nPos: [110,210,10](https://www.izurvive.com/#location=110;210;6)');
    expect(description).toContain('Victim\nPos: [100,200,10](https://www.izurvive.com/#location=100;200;6)');
    expect(json.footer?.text).toBe(SERVER);
    expect(json.fields ?? []).toHaveLength(0);
  });

  it('renders Self Kill Report with weapon, Pos, alias and event time', () => {
    const json = buildGameplayFeedEmbed(view({
      kind: 'DEATH',
      category: 'SUICIDE',
      eventType: 'PLAYER_SUICIDE',
      actorName: 'Solo',
      targetName: null,
      targetPosition: null,
      toolOrWeapon: 'IJ-70',
      distanceMeters: null,
    }), '#dc2626', SERVER).toJSON();
    const description = json.description ?? '';
    expect(description).toContain('**🩸 Self Kill Report**');
    expectOrder(description, ['**Spieler:**', '**Waffe:**', '**Pos::**', '**Ereigniszeit:**']);
    expect(description).toContain('**Waffe:** IJ-70');
    expect(description).toContain(EVENT_TIME);
    expect(json.footer?.text).toBe(SERVER);
  });

  it('renders Wild Kill Report only for the visible Wild/Infizierten cause model plus event time', () => {
    const json = buildGameplayFeedEmbed(view({
      kind: 'DEATH',
      category: 'NPC',
      eventType: 'NPC_KILL',
      actorName: 'Survivor',
      targetName: 'Animal_CanisLupus',
      targetPosition: null,
      toolOrWeapon: null,
      distanceMeters: null,
    }), '#dc2626', SERVER).toJSON();
    const description = json.description ?? '';
    expect(description).toContain('**☣️ Wild Kill Report**');
    expectOrder(description, ['**Opfer:**', '**Ursache:**', '**Pos::**', '**Ereigniszeit:**']);
    expect(description).toContain('Animal\\_CanisLupus');
    expect(description).toContain(EVENT_TIME);
    expect(json.footer?.text).toBe(SERVER);
  });

  it('renders Crash Kill Report with vehicle cause, Pos, alias and event time', () => {
    const json = buildGameplayFeedEmbed(view({
      kind: 'DEATH',
      category: 'VEHICLE',
      eventType: 'VEHICLE_DEATH',
      targetName: 'OffroadHatchback',
      targetPosition: null,
      toolOrWeapon: null,
      distanceMeters: null,
    }), '#dc2626', SERVER).toJSON();
    const description = json.description ?? '';
    expect(description).toContain('**💥 Crash Kill Report**');
    expectOrder(description, ['**Opfer:**', '**Fahrzeug / Ursache:**', '**Pos::**', '**Ereigniszeit:**']);
    expect(description).toContain('**Fahrzeug / Ursache:** OffroadHatchback');
    expect(description).toContain(EVENT_TIME);
    expect(json.footer?.text).toBe(SERVER);
  });

  it('renders generic Death Report with retained raw cause, Pos, alias and event time', () => {
    const json = buildGameplayFeedEmbed(view({
      kind: 'DEATH',
      category: 'OTHER',
      eventType: 'PLAYER_DIED',
      actorName: 'Survivor',
      targetName: 'Bled out',
      targetPosition: null,
      toolOrWeapon: null,
      distanceMeters: null,
    }), '#dc2626', SERVER).toJSON();
    const description = json.description ?? '';
    expect(description).toContain('**☠️ Death Report**');
    expectOrder(description, ['**Spieler:**', '**Todesursache:**', '**Pos::**', '**Ereigniszeit:**']);
    expect(description).toContain('**Todesursache:** Bled out');
    expect(description).toContain(EVENT_TIME);
    expect(json.footer?.text).toBe(SERVER);
  });

  it('does not invent a generic death cause when the ADM line has none', () => {
    expect(descriptionFor(view({
      kind: 'DEATH',
      category: 'OTHER',
      eventType: 'PLAYER_DIED',
      targetName: null,
      targetPosition: null,
      toolOrWeapon: null,
      distanceMeters: null,
    }))).toContain('**Todesursache:** Im ADM-Log nicht näher angegeben');
  });

  const buildCases = [
    ['PLACEMENT', 'PLACEMENT', '📦 Placement Report'],
    ['BUILD', 'BUILD', '🔨 Build Report'],
    ['DISMANTLE', 'DISMANTLE', '🔧 Dismantle Report'],
    ['DESTROY', 'DESTROY', '💥 Destruction Report'],
  ] as const;

  it.each(buildCases)('renders %s as the approved compact report with alias footer and event time', (_event, category, title) => {
    const feed = view({
      kind: category === 'PLACEMENT' ? 'PLACEMENT' : 'BUILD',
      category,
      eventType: category,
      actorName: 'Builder',
      targetName: null,
      objectType: 'Fence',
      toolOrWeapon: category === 'PLACEMENT' ? null : 'Hatchet',
      distanceMeters: null,
      targetPosition: null,
    });
    const json = buildGameplayFeedEmbed(feed, '#eab308', SERVER).toJSON();
    const description = json.description ?? '';
    expect(description).toContain(`**${title}**`);
    expect(description).toContain('**Spieler:** Builder');
    expect(description).toContain('**Objekt:** Fence');
    expect(description).toContain(EVENT_TIME);
    expect(json.footer?.text).toBe(SERVER);
  });

  it('cleans technical Placement classnames without changing ADM source data', () => {
    expect(placementObjectLabel('Snare Trap<RabbitSnareTrap>')).toBe('Snare Trap');
    expect(placementObjectLabel('Nameless Object<GardenPlot>')).toBe('Nameless Gartenplot');
    expect(placementObjectLabel('Nameless Object<WatchtowerKit>')).toBe('Nameless Watchtower Kit');

    expect(descriptionFor(view({
      kind: 'PLACEMENT',
      category: 'PLACEMENT',
      eventType: 'PLACEMENT',
      actorName: 'Builder',
      targetName: null,
      objectType: 'Snare Trap<RabbitSnareTrap>',
      toolOrWeapon: null,
      distanceMeters: null,
      targetPosition: null,
    }))).toContain('**Objekt:** Snare Trap');

    expect(descriptionFor(view({
      kind: 'PLACEMENT',
      category: 'PLACEMENT',
      eventType: 'PLACEMENT',
      actorName: 'Builder',
      targetName: null,
      objectType: 'Nameless Object<GardenPlot>',
      toolOrWeapon: null,
      distanceMeters: null,
      targetPosition: null,
    }))).toContain('**Objekt:** Nameless Gartenplot');
  });

  it('keeps iZurvive linking in build report positions', () => {
    expect(descriptionFor(view({
      kind: 'BUILD',
      category: 'BUILD',
      eventType: 'BUILD',
      actorName: 'Builder',
      targetName: null,
      objectType: 'Fence',
      toolOrWeapon: 'Shovel',
      distanceMeters: null,
      targetPosition: null,
    }))).toContain('**Position:** [100,200,10](https://www.izurvive.com/#location=100;200;6)');
  });
});
