import { newDateContext, parseAdmLine } from '../../src/modules/nitrado/adm/admLineParser';
import { categoryAllowed, categoryForEvent, kindForEvent } from '../../src/modules/gameplayFeeds/types';

function ctx() {
  return newDateContext(new Date(Date.UTC(2026, 8, 7)));
}

function death(action: string) {
  return parseAdmLine(`12:00:00 | Player "Victim" (DEAD) (id=victim-guid pos=<100, 20, 300>) ${action}`, ctx());
}

describe('ADM vanilla kill/death feed coverage', () => {
  test('keeps a canonical player-attributed kill exclusively in first-class KILL/PVP', () => {
    const event = death('killed by Player "Killer" (id=killer-guid pos=<110, 20, 310>) with M4-A1 from 14.2 meters');

    expect(event).toMatchObject({
      eventType: 'PLAYER_KILLED',
      actorGameId: 'victim-guid',
      targetGameId: 'killer-guid',
      targetName: 'Killer',
      toolOrWeapon: 'M4-A1',
      distanceMeters: 14.2,
    });
    expect(kindForEvent(event!.eventType)).toBe('KILL');
    expect(categoryForEvent(event!.eventType)).toBe('PVP');
    expect(categoryAllowed('KILL', ['PVP'], event!.eventType)).toBe(true);
    expect(categoryAllowed('DEATH', ['SUICIDE', 'NPC', 'VEHICLE', 'OTHER'], event!.eventType)).toBe(false);
  });

  test('keeps committed suicide exclusively in DEATH/SUICIDE', () => {
    const event = death('committed suicide');
    expect(event?.eventType).toBe('PLAYER_SUICIDE');
    expect(kindForEvent(event!.eventType)).toBe('DEATH');
    expect(categoryForEvent(event!.eventType)).toBe('SUICIDE');
    expect(categoryAllowed('DEATH', ['SUICIDE'], event!.eventType)).toBe(true);
    expect(categoryAllowed('KILL', ['PVP'], event!.eventType)).toBe(false);
  });

  test.each([
    'Animal_CanisLupus',
    'Animal_UrsusArctos',
    'ZmbM_HermitSkinny_Beige',
    'ZmbF_CitizenANormal_Beige',
  ])('keeps vanilla animal/infected source %s exclusively in DEATH/NPC', cause => {
    const event = death(`killed by ${cause}`);
    expect(event).toMatchObject({ eventType: 'NPC_KILL', targetName: cause });
    expect(kindForEvent(event!.eventType)).toBe('DEATH');
    expect(categoryForEvent(event!.eventType)).toBe('NPC');
    expect(categoryAllowed('DEATH', ['NPC'], event!.eventType)).toBe(true);
    expect(categoryAllowed('KILL', ['PVP'], event!.eventType)).toBe(false);
  });

  test.each([
    'M67 Fragmentation Grenade',
    'Land Mine',
    'Claymore Mine',
    'Wolf',
    'Bear',
    'UnknownObject',
  ])('keeps non-player cause %s out of guessed categories but delivers it as DEATH/OTHER', cause => {
    const event = death(`killed by ${cause}`);
    expect(event).toMatchObject({ eventType: 'PLAYER_DIED', targetName: cause });
    expect(kindForEvent(event!.eventType)).toBe('DEATH');
    expect(categoryForEvent(event!.eventType)).toBe('OTHER');
    expect(categoryAllowed('DEATH', ['OTHER'], event!.eventType)).toBe(true);
    expect(categoryAllowed('DEATH', ['NPC', 'VEHICLE', 'SUICIDE'], event!.eventType)).toBe(false);
    expect(categoryAllowed('KILL', ['PVP'], event!.eventType)).toBe(false);
  });

  test('keeps a fatal engine vehicle line exclusively in DEATH/VEHICLE', () => {
    const event = death('hit by [vehicle] OffroadHatchback at speed 78 km/h');
    expect(event).toMatchObject({ eventType: 'VEHICLE_DEATH', targetName: 'OffroadHatchback' });
    expect(kindForEvent(event!.eventType)).toBe('DEATH');
    expect(categoryForEvent(event!.eventType)).toBe('VEHICLE');
    expect(categoryAllowed('DEATH', ['VEHICLE'], event!.eventType)).toBe(true);
    expect(categoryAllowed('KILL', ['PVP'], event!.eventType)).toBe(false);
  });

  test.each([
    ['has drowned while unconscious', 'Drowned while unconscious'],
    ['bled out', 'Bled out'],
    ['is choosing to respawn', 'Respawn'],
    ['is disconnecting while being unconscious', 'Disconnect while unconscious'],
    ['is disconnecting while being restrained', 'Disconnect while restrained'],
    ['drowned.', 'Drowned'],
  ])('retains and exposes raw death cause %s as DEATH/OTHER', (action, cause) => {
    const event = death(action);
    expect(event).toMatchObject({ eventType: 'PLAYER_DIED', targetName: cause });
    expect(kindForEvent(event!.eventType)).toBe('DEATH');
    expect(categoryForEvent(event!.eventType)).toBe('OTHER');
  });

  test('keeps generic died stats as DEATH/OTHER without inventing a cause', () => {
    const event = death('died. Stats> Water: 0 Energy: 0 Bleed sources: 0');
    expect(event).toMatchObject({ eventType: 'PLAYER_DIED', targetName: null });
    expect(kindForEvent(event!.eventType)).toBe('DEATH');
    expect(categoryForEvent(event!.eventType)).toBe('OTHER');
  });

  test.each([
    'Chat("Reporter"(id=reporter)): Victim was killed by Animal_CanisLupus',
    'Chat("Reporter"(id=reporter)): Player Victim committed suicide',
    'Chat("Reporter"(id=reporter)): Victim hit by [vehicle] OffroadHatchback at speed 90 km/h',
    'Chat("Reporter"(id=reporter)): Player Victim is connected',
  ])('never promotes chat/report text into a gameplay category: %s', content => {
    const event = parseAdmLine(`12:05:00 | ${content}`, ctx());
    if (!event) return;
    expect(kindForEvent(event.eventType)).toBeNull();
    expect(categoryForEvent(event.eventType)).toBeNull();
  });

  test('requires canonical id+position evidence before a death action can become visible', () => {
    const pseudo = parseAdmLine(
      '12:06:00 | Player "Victim" (DEAD) (id=victim-guid) killed by Player "Killer" (id=killer-guid pos=<1,2,3>) with M4-A1 from 10 meters',
      ctx(),
    );
    expect(pseudo?.eventType).toBe('UNKNOWN');
    expect(kindForEvent(pseudo!.eventType)).toBeNull();
  });
});
