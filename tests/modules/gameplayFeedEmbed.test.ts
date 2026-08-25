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

describe('Gameplay-Feed Embed', () => {
  it('rendert Namen ohne sichtbare Inline-Code-Escapes, ohne technische ID und mit Ereigniszeit unter dem Server', () => {
    const embed = buildGameplayFeedEmbed(suicideView(), '#dc2626', 'Test Server').toJSON();
    const player = embed.fields?.find(field => field.name === 'Spieler');

    expect(player?.value).toBe('Void\\_\\_Architect');
    expect(player?.value).not.toContain('`');
    expect(embed.footer).toBeUndefined();
    expect(embed.timestamp).toBeUndefined();
    expect(embed.fields?.at(-2)).toMatchObject({ name: 'Server', value: 'Test Server' });
    expect(embed.fields?.at(-1)).toMatchObject({ name: 'Zeitpunkt', value: '<t:1786844100:F>' });
    expect(JSON.stringify(embed)).not.toContain('cmsv0lqzv000a07mzox0xu5pf');
  });

  it('verlinkt DayZ-Koordinaten direkt auf eine iZurvive-Location', () => {
    expect(izurvivePositionUrl('3005, 13205, 211.6'))
      .toBe('https://www.izurvive.com/#location=3005;13205;6');

    const embed = buildGameplayFeedEmbed(suicideView(), '#dc2626', 'Test Server').toJSON();
    const position = embed.fields?.find(field => field.name === 'Pos:');
    expect(position?.value)
      .toBe('[3005, 13205, 211.6](https://www.izurvive.com/#location=3005;13205;6)');
  });
});
