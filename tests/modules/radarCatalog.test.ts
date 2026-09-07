import type { AdmEventType } from '@prisma/client';
import {
  RADAR_FUNCTIONS,
  isExplosiveRadarEvent,
  radarFunctionByKey,
  radarHasPunitiveFunction,
  type RadarAdmEvent,
} from '../../src/modules/radar/catalog';

function event(overrides: Partial<RadarAdmEvent> = {}): RadarAdmEvent {
  return {
    id: 'adm-1',
    eventType: 'PLAYER_POSITION' as AdmEventType,
    occurredAt: new Date('2026-09-06T20:00:00Z'),
    actorGameId: 'aaaaaaaaaaaaaaaa',
    actorName: 'Actor',
    targetGameId: null,
    targetName: null,
    objectType: null,
    toolOrWeapon: null,
    distanceMeters: null,
    actorPosition: '1000,2000,300',
    targetPosition: null,
    rawLine: null,
    ...overrides,
  };
}

describe('Radar-Funktionskatalog', () => {
  it('enthaelt exakt die vereinbarten elf UI-Funktionen und nur PLAYER_DETECTION ist nicht-punitiv', () => {
    expect(RADAR_FUNCTIONS.map(item => item.key)).toEqual([
      'PLAYER_DETECTION',
      'BAN_PLAYER_DETECTION',
      'BAN_PLACEMENT',
      'BAN_BUILD',
      'BAN_DISMANTLE',
      'BAN_DESTROY',
      'BAN_FLAG',
      'BAN_DISCONNECT',
      'BAN_HIT',
      'BAN_KILL',
      'BAN_EXPLOSION',
    ]);
    expect(RADAR_FUNCTIONS.filter(item => !item.punitive).map(item => item.key)).toEqual(['PLAYER_DETECTION']);
    expect(radarHasPunitiveFunction(['PLAYER_DETECTION'])).toBe(false);
    expect(radarHasPunitiveFunction(['PLAYER_DETECTION', 'BAN_BUILD'])).toBe(true);
  });

  it('ordnet Platzierung/Bauen/Demontage/Zerstoerung immer dem ausfuehrenden Actor zu', () => {
    for (const [key, eventType] of [
      ['BAN_PLACEMENT', 'PLACEMENT'],
      ['BAN_BUILD', 'BUILD'],
      ['BAN_DISMANTLE', 'DISMANTLE'],
      ['BAN_DESTROY', 'DESTROY'],
    ] as const) {
      const selected = radarFunctionByKey(key)?.selectPositions(event({ eventType }));
      expect(selected?.[0]).toMatchObject({
        identity: 'ACTOR',
        gameId: 'aaaaaaaaaaaaaaaa',
        playerName: 'Actor',
        position: { x: 1000, y: 2000, altitude: 300 },
      });
    }
  });

  it('bannt bei Hit und Kill ausschliesslich den Angreifer/Killer samt dessen X/Z', () => {
    const base = event({
      actorGameId: 'victimvictimvict',
      actorName: 'Victim',
      actorPosition: '100,200,30',
      targetGameId: 'killerkillerkill',
      targetName: 'Killer',
      targetPosition: '4000,5000,350',
    });
    expect(radarFunctionByKey('BAN_HIT')?.selectPositions({ ...base, eventType: 'PLAYER_HIT' })).toEqual([
      expect.objectContaining({
        identity: 'TARGET',
        gameId: 'killerkillerkill',
        playerName: 'Killer',
        position: { x: 4000, y: 5000, altitude: 350 },
        relatedGameId: 'victimvictimvict',
        relatedName: 'Victim',
      }),
    ]);
    expect(radarFunctionByKey('BAN_KILL')?.selectPositions({ ...base, eventType: 'PLAYER_KILLED' })).toHaveLength(1);
  });

  it('verwirft Hit/Kill ohne eindeutigen fremden Spieler als Taeter', () => {
    const hit = radarFunctionByKey('BAN_HIT')!;
    expect(hit.selectPositions(event({ eventType: 'PLAYER_HIT', targetGameId: null, targetPosition: null }))).toEqual([]);
    expect(hit.selectPositions(event({
      eventType: 'PLAYER_HIT',
      targetGameId: 'aaaaaaaaaaaaaaaa',
      targetPosition: '1000,2000,300',
    }))).toEqual([]);
  });

  it('normalisiert dynamische Flag-Totems X/Hoehe/Z und verwendet die exakte Flaggenposition', () => {
    const candidates = radarFunctionByKey('BAN_FLAG')?.selectPositions(event({
      eventType: 'UNKNOWN',
      targetName: 'StaticFlagPole',
      objectType: 'Flag_Chernarus',
      targetPosition: '4643.467773,339.000000,10338.107422',
      rawLine: 'Player "Actor" (id=aaaaaaaaaaaaaaaa pos=<4640, 338, 10330>) has raised Flag_Chernarus on StaticFlagPole at <4643.467773,339.000000,10338.107422>',
    }));
    expect(candidates).toEqual([
      expect.objectContaining({
        identity: 'ACTOR',
        gameId: 'aaaaaaaaaaaaaaaa',
        relatedName: 'StaticFlagPole',
        position: { x: 4643.467773, y: 10338.107422, altitude: 339 },
      }),
    ]);
  });

  it('rejects UNKNOWN lookalikes when canonical raw flag evidence disagrees', () => {
    const flag = radarFunctionByKey('BAN_FLAG')!;
    expect(flag.selectPositions(event({
      eventType: 'UNKNOWN',
      targetName: 'StaticFlagPole',
      objectType: 'Flag_Chernarus',
      targetPosition: '4643.467773,339.000000,10338.107422',
      rawLine: 'Player "Actor" (id=aaaaaaaaaaaaaaaa pos=<4640, 338, 10330>) has raised Flag_Chernarus on TerritoryFlag at <4643.467773,339.000000,10338.107422>',
    }))).toEqual([]);
    expect(flag.selectPositions(event({
      eventType: 'UNKNOWN',
      targetName: 'StaticFlagPole',
      objectType: 'Flag_Chernarus',
      targetPosition: '4643.467773,339.000000,10338.107422',
      rawLine: 'some unrelated UNKNOWN line',
    }))).toEqual([]);
  });

  it('erkennt Explosion nur mit Explosiv-Evidenz und verhindert Doppelzuordnung zu Hit/Kill', () => {
    const explosive = event({
      eventType: 'PLAYER_HIT',
      actorGameId: 'victimvictimvict',
      actorName: 'Victim',
      targetGameId: 'killerkillerkill',
      targetName: 'Killer',
      targetPosition: '4000,5000,350',
      toolOrWeapon: 'M79',
      rawLine: 'Player "Victim" hit by Player "Killer" with M79',
    });
    expect(isExplosiveRadarEvent(explosive)).toBe(true);
    expect(radarFunctionByKey('BAN_EXPLOSION')?.selectPositions(explosive)).toHaveLength(1);
    expect(radarFunctionByKey('BAN_HIT')?.selectPositions(explosive)).toEqual([]);

    const anonymousExplosion = event({
      eventType: 'PLAYER_HIT',
      actorGameId: 'victimvictimvict',
      targetGameId: null,
      targetPosition: null,
      rawLine: 'Player "Victim" hit by explosion (RGD5Grenade_Ammo)',
    });
    expect(isExplosiveRadarEvent(anonymousExplosion)).toBe(true);
    expect(radarFunctionByKey('BAN_EXPLOSION')?.selectPositions(anonymousExplosion)).toEqual([]);
  });
});
