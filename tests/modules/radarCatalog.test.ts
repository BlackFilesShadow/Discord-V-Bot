import type { RadarAdmEvent } from '../../src/modules/radar/catalog';
import { RADAR_FUNCTIONS, radarFunctionsForEvent } from '../../src/modules/radar/catalog';

function event(overrides: Partial<RadarAdmEvent> = {}): RadarAdmEvent {
  return {
    id: 'adm-1',
    eventType: 'PLAYER_POSITION',
    occurredAt: new Date('2026-09-04T22:41:03.000Z'),
    actorGameId: 'guid-1',
    actorName: 'Void',
    targetGameId: null,
    targetName: null,
    objectType: null,
    toolOrWeapon: null,
    distanceMeters: null,
    actorPosition: '4382.5, 10216.4, 213.6',
    targetPosition: null,
    ...overrides,
  };
}

describe('Radar function catalog', () => {
  it('liefert Spieler-Erkennung standardmaessig aktiv und ohne erfundene Aktion', () => {
    const definition = radarFunctionsForEvent('PLAYER_POSITION')[0];
    const candidates = definition.selectPositions(event());
    expect(definition).toMatchObject({ key: 'PLAYER_DETECTION', defaultEnabled: true });
    expect(candidates).toEqual([{
      identity: 'ACTOR',
      gameId: 'guid-1',
      playerName: 'Void',
      position: { x: 4382.5, y: 10216.4, altitude: 213.6 },
    }]);
  });

  it('wertet nur Ereignisse mit belastbarer Position aus und sortiert den Katalog stabil', () => {
    expect(radarFunctionsForEvent('PLAYER_CONNECTED')).toEqual([]);
    expect(radarFunctionsForEvent('BUILD')[0].selectPositions(event({ eventType: 'BUILD', actorPosition: null }))).toEqual([]);
    expect(RADAR_FUNCTIONS.map(definition => definition.order)).toEqual([...RADAR_FUNCTIONS.map(definition => definition.order)].sort((a, b) => a - b));
  });
});