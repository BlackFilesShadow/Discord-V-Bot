import { buildGameplayFeedEmbed } from '../../src/modules/gameplayFeeds/embedBuilder';
import {
  deriveGameplayFeedView,
  type GameplayAdmEvent,
} from '../../src/modules/gameplayFeeds/types';
import {
  newDateContext,
  parseAdmLine,
  type ParsedAdmEvent,
} from '../../src/modules/nitrado/adm/admLineParser';

function gameplayEvent(parsed: ParsedAdmEvent): GameplayAdmEvent {
  return {
    id: 'self-kill-regression-event',
    eventType: parsed.eventType,
    occurredAt: parsed.occurredAt,
    createdAt: new Date('2026-09-03T01:06:01.000Z'),
    actorGameId: parsed.actorGameId,
    actorName: parsed.actorName,
    targetGameId: parsed.targetGameId,
    targetName: parsed.targetName,
    objectType: parsed.objectType,
    toolOrWeapon: parsed.toolOrWeapon,
    distanceMeters: parsed.distanceMeters,
    actorPosition: parsed.actorPosition,
    targetPosition: parsed.targetPosition,
  };
}

function parseSelfKill(line: string): GameplayAdmEvent {
  const ctx = newDateContext(new Date(Date.UTC(2026, 8, 3)));
  const parsed = parseAdmLine(line, ctx);
  if (!parsed) throw new Error('ADM-Zeile wurde unerwartet nicht geparst');
  return gameplayEvent(parsed);
}

describe('Self-Kill Waffenanzeige aus ADM-V2', () => {
  it('bezeichnet eine in der ADM-Zeile nicht angegebene Waffe praezise', () => {
    const event = parseSelfKill(
      '01:06:00 | Player "DrQuinnxX" (DEAD) (id=1 pos=<5601.6, 2068.5, 7.5>) committed suicide',
    );
    const view = deriveGameplayFeedView(event, {
      showActorCoords: true,
      showTargetCoords: false,
      showTool: true,
      showDistance: false,
    });

    expect(event.eventType).toBe('PLAYER_SUICIDE');
    expect(event.toolOrWeapon).toBeNull();
    expect(view).not.toBeNull();

    const embed = buildGameplayFeedEmbed(view!, '#dc2626', 'Die Chaoten').toJSON();
    expect(embed.fields?.find(field => field.name === 'Waffe')?.value)
      .toBe('Im ADM-Log nicht angegeben');
  });

  it('zeigt eine von ADM gelieferte Suizidwaffe unveraendert an', () => {
    const event = parseSelfKill(
      '01:06:00 | Player "DrQuinnxX" (DEAD) (id=1 pos=<5601.6, 2068.5, 7.5>) committed suicide with IJ-70',
    );
    const view = deriveGameplayFeedView(event, {
      showActorCoords: true,
      showTargetCoords: false,
      showTool: true,
      showDistance: false,
    });

    expect(event.toolOrWeapon).toBe('IJ-70');
    const embed = buildGameplayFeedEmbed(view!, '#dc2626', 'Die Chaoten').toJSON();
    expect(embed.fields?.find(field => field.name === 'Waffe')?.value).toBe('IJ-70');
  });

  it('blendet das Waffenfeld komplett aus wenn Waffe / Ursache deaktiviert ist', () => {
    const event = parseSelfKill(
      '01:06:00 | Player "DrQuinnxX" (DEAD) (id=1 pos=<5601.6, 2068.5, 7.5>) committed suicide',
    );
    const view = deriveGameplayFeedView(event, {
      showActorCoords: true,
      showTargetCoords: false,
      showTool: false,
      showDistance: false,
    });

    expect(view?.showTool).toBe(false);
    const embed = buildGameplayFeedEmbed(view!, '#dc2626', 'Die Chaoten').toJSON();
    expect(embed.fields?.some(field => field.name === 'Waffe')).toBe(false);
  });
});
