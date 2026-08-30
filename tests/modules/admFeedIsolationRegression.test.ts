import { newDateContext, parseAdmLine } from '../../src/modules/nitrado/adm/admLineParser';
import { categoryAllowed, kindForEvent } from '../../src/modules/gameplayFeeds/types';

function ctx() {
  return newDateContext(new Date(Date.UTC(2026, 7, 30)));
}

describe('#293 ADM feed negative/golden isolation', () => {
  it.each(['Bear', 'Wolf', 'Zombie', 'Infected'])('keeps %s kills in NPC and never PvP/Vehicle', cause => {
    const event = parseAdmLine(
      `12:00:00 | Player "Victim" (DEAD) (id=game-1 pos=<1,2,3>) killed by ${cause}`,
      ctx(),
    );
    expect(event?.eventType).toBe('NPC_KILL');
    expect(event?.targetName).toBe(cause);
    expect(kindForEvent(event!.eventType)).toBe('DEATH');
    expect(categoryAllowed('DEATH', ['NPC'], event!.eventType)).toBe(true);
    expect(categoryAllowed('DEATH', ['PVP'], event!.eventType)).toBe(false);
    expect(categoryAllowed('DEATH', ['VEHICLE'], event!.eventType)).toBe(false);
  });

  it('never upgrades a DEAD explosion hit into a deathfeed event by itself', () => {
    const event = parseAdmLine(
      '12:01:00 | Player "Victim" (DEAD) (id=game-1 pos=<1,2,3>) hit by explosion (Explosion_40mm_Ammo)',
      ctx(),
    );
    expect(event?.eventType).toBe('PLAYER_HIT');
    expect(kindForEvent(event!.eventType)).toBeNull();
    expect(categoryAllowed('DEATH', ['PVP', 'SUICIDE', 'NPC', 'VEHICLE'], event!.eventType)).toBe(false);
  });

  it('keeps a nonfatal vehicle hit out of the deathfeed', () => {
    const event = parseAdmLine(
      '12:02:00 | Player "Victim" (id=game-1 pos=<1,2,3>) hit by [vehicle] OffroadHatchback at speed 35 km/h',
      ctx(),
    );
    expect(event?.eventType).toBe('PLAYER_HIT');
    expect(kindForEvent(event!.eventType)).toBeNull();
  });

  it('only the canonical killed-by-player line is PvP', () => {
    const hit = parseAdmLine(
      '12:03:00 | Player "Victim" (DEAD) (id=game-1 pos=<1,2,3>) hit by explosion (Explosion_40mm_Ammo)',
      ctx(),
    );
    const kill = parseAdmLine(
      '12:03:01 | Player "Victim" (DEAD) (id=game-1 pos=<1,2,3>) killed by Player "Killer" (id=game-2 pos=<4,5,6>) with M79 from 20 meters',
      ctx(),
    );
    expect(hit?.eventType).toBe('PLAYER_HIT');
    expect(kill?.eventType).toBe('PLAYER_KILLED');
    expect(categoryAllowed('DEATH', ['PVP'], hit!.eventType)).toBe(false);
    expect(categoryAllowed('DEATH', ['PVP'], kill!.eventType)).toBe(true);
  });
});
