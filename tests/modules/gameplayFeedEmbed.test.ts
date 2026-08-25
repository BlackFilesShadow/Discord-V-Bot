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
    actorPosition: '3005, 13205, 211.6',
    targetPosition: null,
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
  it('rendert Namen ohne sichtbare Inline-Code-Escapes und ohne Footer/Zeitstempel', () => {
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
    const position = embed.fields?.find(field => field.name === 'Pos:');
    expect(position?.value)
      .toBe('[3005, 13205, 211.6](https://www.izurvive.com/#location=3005;13205;6)');
    expect(embed.fields?.at(-1)).toMatchObject({ name: 'Server', value: 'Test Server' });
  });

  it('laesst Death/Kill-Feeds ohne Ereigniszeit', () => {
    const embed = buildGameplayFeedEmbed(suicideView(), '#dc2626', 'Kill Server').toJSON();
    expect(embed.fields?.some(field => field.name === 'Ereigniszeit')).toBe(false);
    expect(embed.fields?.at(-1)).toMatchObject({ name: 'Server', value: 'Kill Server' });
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
