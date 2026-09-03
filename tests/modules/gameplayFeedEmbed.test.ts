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
  it('rendert Namen ohne sichtbare Inline-Code-Escapes und ohne Footer/Embed-Zeitstempel', () => {
    const embed = buildGameplayFeedEmbed(suicideView(), '#dc2626', 'Test Server').toJSON();
    const player = embed.fields?.find(field => field.name === 'Spieler');

    // EscapeMarkdown bleibt als Schutz erhalten; ausserhalb eines Codeblocks
    // interpretiert Discord die Backslashes und zeigt sichtbar Void__Architect.
    expect(player?.value).toBe('Void\\_\\_Architect');
    expect(player?.value).not.toContain('`');
    expect(embed.footer).toBeUndefined();
    expect(embed.timestamp).toBeUndefined();
  });

  it('verlinkt DayZ-Koordinaten direkt auf eine iZurvive-Location', () => {
    expect(izurvivePositionUrl('3005, 13205, 211.6'))
      .toBe('https://www.izurvive.com/#location=3005;13205;6');

    const embed = buildGameplayFeedEmbed(suicideView(), '#dc2626', 'Test Server').toJSON();
    const fields = embed.fields ?? [];
    const position = fields.find(field => field.name === 'Pos:');
    const serverIndex = fields.findIndex(field => field.name === 'Server');
    expect(position?.value)
      .toBe('[3005, 13205, 211.6](https://www.izurvive.com/#location=3005;13205;6)');
    expect(fields[serverIndex]).toMatchObject({ name: 'Server', value: 'Test Server' });
    expect(fields[serverIndex + 1]?.name).toBe('Ereigniszeit');
  });

  it('laesst ausschliesslich den V-Kill/PvP-Feed ohne Ereigniszeit', () => {
    const embed = buildGameplayFeedEmbed(pvpView(), '#dc2626', 'Kill Server').toJSON();
    expect(embed.fields?.some(field => field.name === 'Ereigniszeit')).toBe(false);
    expect(embed.fields?.at(-1)).toMatchObject({ name: 'Server', value: 'Kill Server' });
    expect(JSON.stringify(embed)).not.toContain('hidden-pvp-event-id');
  });

  it('zeigt Self-Kill die Ereigniszeit direkt unter dem Server-Alias', () => {
    const embed = buildGameplayFeedEmbed(suicideView(), '#dc2626', 'Self Kill Server').toJSON();
    const fields = embed.fields ?? [];
    const serverIndex = fields.findIndex(field => field.name === 'Server');

    expect(serverIndex).toBeGreaterThanOrEqual(0);
    expect(fields[serverIndex]).toMatchObject({ name: 'Server', value: 'Self Kill Server', inline: false });
    expect(fields[serverIndex + 1]).toMatchObject({
      name: 'Ereigniszeit',
      value: `<t:${Math.floor(new Date('2026-08-16T01:35:00.000Z').getTime() / 1000)}:F>`,
      inline: false,
    });
  });

  it('zeigt bei Nicht-Kill-Nitrado-Feeds die Ereigniszeit direkt unter dem Server-Alias und keine technische ID', () => {
    const embed = buildGameplayFeedEmbed(buildView(), '#2563eb', 'Build Server').toJSON();
    const fields = embed.fields ?? [];
    const serverIndex = fields.findIndex(field => field.name === 'Server');

    expect(serverIndex).toBeGreaterThanOrEqual(0);
    expect(fields[serverIndex]).toMatchObject({ name: 'Server', value: 'Build Server', inline: false });
    expect(fields[serverIndex + 1]).toMatchObject({
      name: 'Ereigniszeit',
      value: `<t:${Math.floor(new Date('2026-08-16T03:42:00.000Z').getTime() / 1000)}:F>`,
      inline: false,
    });
    expect(JSON.stringify(embed)).not.toContain('technical-event-id-must-stay-hidden');
    expect(embed.footer).toBeUndefined();
    expect(embed.timestamp).toBeUndefined();
  });
});

  it('zeigt nur durch ADM belegte Fernkampf-Trefferdetails auf Deutsch', () => {
    const view = pvpView();
    view.pvpHit = { bodyPart: 'Head', damage: 48.5, damageType: 'FirearmHit_Rifle', weapon: 'M4-A1' };
    const fields = buildGameplayFeedEmbed(view, '#dc2626', 'Kill Server').toJSON().fields ?? [];

    expect(fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Waffe', value: 'M4-A1' }),
      expect.objectContaining({ name: 'Getroffener Körperteil', value: 'Head' }),
      expect.objectContaining({ name: 'Schaden', value: '48,5 (FirearmHit\\_Rifle)' }),
    ]));
  });

  it('zeigt bei Nahkampf ausschliesslich die Waffe', () => {
    const view = pvpView();
    view.pvpHit = { bodyPart: 'LeftArm', damage: 2.85, damageType: 'MeleeSoft', weapon: 'Rooster' };
    const fields = buildGameplayFeedEmbed(view, '#dc2626', 'Kill Server').toJSON().fields ?? [];

    expect(fields.find(field => field.name === 'Waffe')?.value).toBe('Rooster');
    expect(fields.some(field => field.name === 'Getroffener Körperteil' || field.name === 'Schaden')).toBe(false);
  });
