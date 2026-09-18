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

    const description = buildGameplayFeedEmbed(view!, '#dc2626', 'Die Chaoten').toJSON().description ?? '';
    expect(description).toContain('**Waffe:** Im ADM-Log nicht angegeben');
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
    const description = buildGameplayFeedEmbed(view!, '#dc2626', 'Die Chaoten').toJSON().description ?? '';
    expect(description).toContain('**Waffe:** IJ-70');
  });

  it('rendert einen killed-by-Player Tod mit identischer Spieler-ID als Self Kill Report', () => {
    const event = parseSelfKill(
      '01:06:03 | Player "Emil_O92" (DEAD) (id=same-player-guid pos=<3510.7, 9872.4, 269.3>) killed by Player "Emil_O92" (id=same-player-guid pos=<3510.7, 9872.4, 269.3>) with M79 from 0 meters',
    );
    const view = deriveGameplayFeedView(event, {
      showActorCoords: true,
      showTargetCoords: true,
      showTool: true,
      showDistance: true,
    });

    expect(event.eventType).toBe('PLAYER_SUICIDE');
    expect(view?.category).toBe('SUICIDE');
    const description = buildGameplayFeedEmbed(view!, '#dc2626', 'Killhouse').toJSON().description ?? '';
    expect(description).toContain('**🩸 Self Kill Report**');
    expect(description).toContain('**Spieler:** Emil\_O92');
    expect(description).toContain('**Waffe:** M79');
    expect(description).not.toContain('V-Kill Report');
    expect(description).not.toContain('**Killer');
    expect(description).not.toContain('**Opfer');
    expect(description).not.toContain('**Distanz:**');
  });

  it('blendet die Waffenzeile komplett aus wenn Waffe / Ursache deaktiviert ist', () => {
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
    const description = buildGameplayFeedEmbed(view!, '#dc2626', 'Die Chaoten').toJSON().description ?? '';
    expect(description).not.toContain('**Waffe:**');
  });
});
