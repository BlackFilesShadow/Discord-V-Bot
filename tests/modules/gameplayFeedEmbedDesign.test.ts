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
    kind: 'DEATH',
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

function fieldsFor(feed: GameplayFeedView) {
  return buildGameplayFeedEmbed(feed, '#dc2626', SERVER).toJSON().fields ?? [];
}

describe('approved V-Bot gameplay feed embed designs', () => {
  it('renders V-Kill Report with Killer before Opfer, inline Pos links and server alias last', () => {
    const json = buildGameplayFeedEmbed(view({}), '#dc2626', SERVER).toJSON();
    expect(json.title).toBe('💀 V-Kill Report');
    expect(json.fields?.map(field => field.name)).toEqual(['Killer', 'Opfer', 'Waffe', 'Distanz', 'Server']);
    expect(json.fields?.[0].value).toBe('Killer\nPos: [110,210,10](https://www.izurvive.com/#location=110;210;6)');
    expect(json.fields?.[1].value).toBe('Victim\nPos: [100,200,10](https://www.izurvive.com/#location=100;200;6)');
    expect(json.fields?.at(-1)).toMatchObject({ name: 'Server', value: SERVER });
  });

  it('renders Self Kill Report with weapon, Pos, alias and event time', () => {
    const json = buildGameplayFeedEmbed(view({
      category: 'SUICIDE',
      eventType: 'PLAYER_SUICIDE',
      actorName: 'Solo',
      targetName: null,
      targetPosition: null,
      toolOrWeapon: 'IJ-70',
      distanceMeters: null,
    }), '#dc2626', SERVER).toJSON();
    expect(json.title).toBe('🩸 Self Kill Report');
    expect(json.fields?.map(field => field.name)).toEqual(['Spieler', 'Waffe', 'Pos:', 'Server', 'Ereigniszeit']);
    expect(json.fields?.find(field => field.name === 'Waffe')?.value).toBe('IJ-70');
    expect(json.fields?.at(-2)).toMatchObject({ name: 'Server', value: SERVER });
    expect(json.fields?.at(-1)).toMatchObject({ name: 'Ereigniszeit', value: EVENT_TIME });
  });

  it('renders Wild Kill Report only for the visible Wild/Infizierten cause model plus event time', () => {
    const json = buildGameplayFeedEmbed(view({
      category: 'NPC',
      eventType: 'NPC_KILL',
      actorName: 'Survivor',
      targetName: 'Wolf',
      targetPosition: null,
      toolOrWeapon: null,
      distanceMeters: null,
    }), '#dc2626', SERVER).toJSON();
    expect(json.title).toBe('☣️ Wild Kill Report');
    expect(json.fields?.map(field => field.name)).toEqual(['Opfer', 'Ursache', 'Pos:', 'Server', 'Ereigniszeit']);
    expect(json.fields?.find(field => field.name === 'Ursache')?.value).toBe('Wolf');
    expect(json.fields?.at(-2)).toMatchObject({ name: 'Server', value: SERVER });
    expect(json.fields?.at(-1)).toMatchObject({ name: 'Ereigniszeit', value: EVENT_TIME });
  });

  it('renders Crash Kill Report with vehicle cause, Pos, alias and event time', () => {
    const json = buildGameplayFeedEmbed(view({
      category: 'VEHICLE',
      eventType: 'VEHICLE_DEATH',
      targetName: 'OffroadHatchback',
      targetPosition: null,
      toolOrWeapon: null,
      distanceMeters: null,
    }), '#dc2626', SERVER).toJSON();
    expect(json.title).toBe('💥 Crash Kill Report');
    expect(json.fields?.map(field => field.name)).toEqual(['Opfer', 'Fahrzeug / Ursache', 'Pos:', 'Server', 'Ereigniszeit']);
    expect(json.fields?.find(field => field.name === 'Fahrzeug / Ursache')?.value).toBe('OffroadHatchback');
    expect(json.fields?.at(-2)).toMatchObject({ name: 'Server', value: SERVER });
    expect(json.fields?.at(-1)).toMatchObject({ name: 'Ereigniszeit', value: EVENT_TIME });
  });

  const buildCases = [
    ['PLACEMENT', 'PLACEMENT', '📦 Placement Report'],
    ['BUILD', 'BUILD', '🔨 Build Report'],
    ['DISMANTLE', 'DISMANTLE', '🔧 Dismantle Report'],
    ['DESTROY', 'DESTROY', '💥 Destruction Report'],
  ] as const;

  it.each(buildCases)('renders %s as the approved report with alias followed by event time', (_event, category, title) => {
    const feed = view({
      kind: 'BUILD',
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
    expect(json.title).toBe(title);
    expect(json.fields?.[0]).toMatchObject({ name: 'Spieler', value: 'Builder' });
    expect(json.fields?.find(field => field.name === 'Objekt')?.value).toBe('Fence');
    expect(json.fields?.at(-2)).toMatchObject({ name: 'Server', value: SERVER });
    expect(json.fields?.at(-1)).toMatchObject({ name: 'Ereigniszeit', value: EVENT_TIME });
  });

  it('cleans technical Placement classnames without changing ADM source data', () => {
    expect(placementObjectLabel('Snare Trap<RabbitSnareTrap>')).toBe('Snare Trap');
    expect(placementObjectLabel('Nameless Object<GardenPlot>')).toBe('Nameless Gartenplot');
    expect(placementObjectLabel('Nameless Object<WatchtowerKit>')).toBe('Nameless Watchtower Kit');

    const snareFields = fieldsFor(view({
      kind: 'BUILD',
      category: 'PLACEMENT',
      eventType: 'PLACEMENT',
      actorName: 'Builder',
      targetName: null,
      objectType: 'Snare Trap<RabbitSnareTrap>',
      toolOrWeapon: null,
      distanceMeters: null,
      targetPosition: null,
    }));
    expect(snareFields.find(field => field.name === 'Objekt')?.value).toBe('Snare Trap');

    const namelessFields = fieldsFor(view({
      kind: 'BUILD',
      category: 'PLACEMENT',
      eventType: 'PLACEMENT',
      actorName: 'Builder',
      targetName: null,
      objectType: 'Nameless Object<GardenPlot>',
      toolOrWeapon: null,
      distanceMeters: null,
      targetPosition: null,
    }));
    expect(namelessFields.find(field => field.name === 'Objekt')?.value).toBe('Nameless Gartenplot');
  });

  it('keeps iZurvive linking in build report positions', () => {
    const fields = fieldsFor(view({
      kind: 'BUILD',
      category: 'BUILD',
      eventType: 'BUILD',
      actorName: 'Builder',
      targetName: null,
      objectType: 'Fence',
      toolOrWeapon: 'Shovel',
      distanceMeters: null,
      targetPosition: null,
    }));
    expect(fields.find(field => field.name === 'Position')?.value).toBe('[100,200,10](https://www.izurvive.com/#location=100;200;6)');
  });
});
