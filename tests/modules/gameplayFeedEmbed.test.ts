import { buildGameplayFeedEmbed, izurvivePositionUrl } from '../../src/modules/gameplayFeeds/embedBuilder';
import type { GameplayFeedView } from '../../src/modules/gameplayFeeds/types';

function suicideView(): GameplayFeedView {
  return {
    eventId: 'cmsv0lqzv000a07mzox0xu5pf',
    kind: 'DEATH',
    category: 'SUICIDE',
    eventType: 'PLAYER_SUICIDE',
    occurredAt: new Date('2026-08-16T01:35:00.000Z'),
    actorName: 'Void__Architect',
    targetName: null,
    objectType: null,
    toolOrWeapon: null,
    distanceMeters: null,
    pvpHit: null,
    actorPosition: '3005, 13205, 211.6',
    targetPosition: null,
  };
}

function pvpView(): GameplayFeedView {
  return {
    ...suicideView(),
    eventId: 'hidden-pvp-event-id',
    kind: 'KILL',
    category: 'PVP',
    eventType: 'PLAYER_KILLED',
    actorName: 'Victim',
    targetName: 'Killer',
    toolOrWeapon: 'M4-A1',
    distanceMeters: 42,
    targetPosition: '3010, 13210, 211.6',
  };
}

function buildView(): GameplayFeedView {
  return {
    eventId: 'technical-event-id-must-stay-hidden',
    kind: 'BUILD',
    category: 'BUILD',
    eventType: 'BUILD',
    occurredAt: new Date('2026-08-16T03:42:00.000Z'),
    actorName: 'Builder',
    targetName: null,
    objectType: 'Fence',
    toolOrWeapon: 'Hammer',
    distanceMeters: null,
    actorPosition: '4000, 5000, 10',
    targetPosition: null,
  };
}

describe('Gameplay-Feed Embed', () => {
  it('rendert Namen ohne sichtbare Inline-Code-Escapes im kompakten Format', () => {
    const embed = buildGameplayFeedEmbed(suicideView(), '#dc2626', 'Test Server').toJSON();
    const description = embed.description ?? '';

    expect(description).toContain('Void\\_\\_Architect');
    expect(description).not.toContain('`Void');
    expect(embed.footer?.text).toBe('Test Server');
    expect(embed.timestamp).toBeUndefined();
    expect(embed.fields ?? []).toHaveLength(0);
  });

  it('verlinkt DayZ-Koordinaten direkt auf eine iZurvive-Location', () => {
    expect(izurvivePositionUrl('3005, 13205, 211.6'))
      .toBe('https://www.izurvive.com/#location=3005;13205;6');

    const embed = buildGameplayFeedEmbed(suicideView(), '#dc2626', 'Test Server').toJSON();
    const description = embed.description ?? '';
    expect(description)
      .toContain('[3005, 13205, 211.6](https://www.izurvive.com/#location=3005;13205;6)');
    expect(description).toContain('**Ereigniszeit:**');
    expect(embed.footer?.text).toBe('Test Server');
  });

  it('laesst ausschliesslich den V-Kill/PvP-Feed ohne Ereigniszeit', () => {
    const embed = buildGameplayFeedEmbed(pvpView(), '#dc2626', 'Kill Server').toJSON();
    expect(embed.description).not.toContain('Ereigniszeit');
    expect(embed.footer?.text).toBe('Kill Server');
    expect(JSON.stringify(embed)).not.toContain('hidden-pvp-event-id');
  });

  it('zeigt Self-Kill die Ereigniszeit und den Server-Alias im Footer', () => {
    const embed = buildGameplayFeedEmbed(suicideView(), '#dc2626', 'Self Kill Server').toJSON();

    expect(embed.footer?.text).toBe('Self Kill Server');
    expect(embed.description).toContain(
      `<t:${Math.floor(new Date('2026-08-16T01:35:00.000Z').getTime() / 1000)}:F>`,
    );
  });

  it('zeigt bei Nicht-Kill-Nitrado-Feeds die Ereigniszeit und keine technische ID', () => {
    const embed = buildGameplayFeedEmbed(buildView(), '#2563eb', 'Build Server').toJSON();

    expect(embed.footer?.text).toBe('Build Server');
    expect(embed.description).toContain(
      `<t:${Math.floor(new Date('2026-08-16T03:42:00.000Z').getTime() / 1000)}:F>`,
    );
    expect(JSON.stringify(embed)).not.toContain('technical-event-id-must-stay-hidden');
    expect(embed.timestamp).toBeUndefined();
  });
});

it('zeigt nur durch ADM belegte Fernkampf-Trefferdetails auf Deutsch', () => {
  const view = pvpView();
  view.pvpHit = { bodyPart: 'Head', damage: 48.5, damageType: 'FirearmHit_Rifle', weapon: 'M4-A1' };
  const description = buildGameplayFeedEmbed(view, '#dc2626', 'Kill Server').toJSON().description ?? '';

  expect(description).toContain('**Waffe:** M4-A1');
  expect(description).toContain('**Getroffener Körperteil:** Head');
  expect(description).toContain('**Schaden:** 48,5 (FirearmHit\\_Rifle)');
});

it('zeigt bei Nahkampf ausschliesslich die Waffe', () => {
  const view = pvpView();
  view.pvpHit = { bodyPart: 'LeftArm', damage: 2.85, damageType: 'MeleeSoft', weapon: 'Rooster' };
  const description = buildGameplayFeedEmbed(view, '#dc2626', 'Kill Server').toJSON().description ?? '';

  expect(description).toContain('**Waffe:** Rooster');
  expect(description).not.toContain('Getroffener Körperteil');
  expect(description).not.toContain('**Schaden:**');
});
