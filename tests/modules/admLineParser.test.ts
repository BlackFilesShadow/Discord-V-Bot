/**
 * Golden-Tests fuer den kanonischen ADM-Zeilenparser.
 */
import { parseAdmLine, newDateContext, resolveBaseDate, ADM_PARSER_VERSION } from '../../src/modules/nitrado/adm/admLineParser';

function ctxWithDate() {
  return newDateContext(new Date(Date.UTC(2026, 6, 1)));
}

describe('admLineParser — Golden', () => {
  it('verwendet die neue Parser-Version fuer korrigierte Feed-Semantik', () => {
    expect(ADM_PARSER_VERSION).toBe(2);
  });

  it('erkennt den Header und setzt das Basisdatum', () => {
    const ctx = newDateContext(null);
    const ev = parseAdmLine('AdminLog started on 2026-07-01 at 18:00:00', ctx);
    expect(ev).toBeNull();
    expect(ctx.baseDate?.getUTCFullYear()).toBe(2026);
  });

  it('connect: beide Formulierungen', () => {
    const a = parseAdmLine('18:00:12 | Player "Alpha"(id=76561190000000001) is connected', ctxWithDate());
    expect(a?.eventType).toBe('PLAYER_CONNECTED');
    expect(a?.actorName).toBe('Alpha');
    expect(a?.actorGameId).toBe('76561190000000001');
    const b = parseAdmLine('18:01:05 | Player "Bravo" (id=76561190000000002 pos=<7500.5, 8500.2, 300.1>) connected', ctxWithDate());
    expect(b?.eventType).toBe('PLAYER_CONNECTED');
    expect(b?.actorPosition).toBe('7500.5, 8500.2, 300.1');
  });

  it('disconnect: beide Formulierungen', () => {
    expect(parseAdmLine('18:20:00 | Player "Alpha"(id=1) has been disconnected', ctxWithDate())?.eventType).toBe('PLAYER_DISCONNECTED');
    expect(parseAdmLine('18:21:00 | Player "Bravo" (id=2 pos=<1,2,3>) disconnected', ctxWithDate())?.eventType).toBe('PLAYER_DISCONNECTED');
  });

  it('PvP-Kill trennt Opfer/Killer und erhaelt Waffen mit Leerzeichen', () => {
    const ev = parseAdmLine('18:05:30 | Player "Bravo"(DEAD) (id=76561190000000002 pos=<7501.0, 8499.0, 300.0>) killed by Player "Alpha" (id=76561190000000001 pos=<7480.0, 8490.0, 300.0>) with Mosin 91/30 from 25.3 meters', ctxWithDate());
    expect(ev?.eventType).toBe('PLAYER_KILLED');
    expect(ev?.actorName).toBe('Bravo');
    expect(ev?.targetName).toBe('Alpha');
    expect(ev?.toolOrWeapon).toBe('Mosin 91/30');
    expect(ev?.distanceMeters).toBeCloseTo(25.3);
  });

  it('PvP-Kill funktioniert ohne DEAD und ohne Player-Praefix beim Killer', () => {
    const ev = parseAdmLine('18:07:11 | Player "Charlie"(id=3, pos=<1000.0, 2000.0, 50.0>) killed by "Alpha"(id=1, pos=<1010.0, 2010.0, 50.0>) with SVD from 300.5 meters', ctxWithDate());
    expect(ev?.eventType).toBe('PLAYER_KILLED');
    expect(ev?.actorName).toBe('Charlie');
    expect(ev?.targetName).toBe('Alpha');
    expect(ev?.toolOrWeapon).toBe('SVD');
    expect(ev?.distanceMeters).toBeCloseTo(300.5);
  });

  it('trennt normalen Tod, Suizid und NPC-Tod', () => {
    expect(parseAdmLine('18:08:00 | Player "Alpha" (DEAD) (id=1 pos=<1,2,3>) died. Stats> Water: 0.0', ctxWithDate())?.eventType).toBe('PLAYER_DIED');
    expect(parseAdmLine('18:09:00 | Player "Alpha" (DEAD) (id=1 pos=<1,2,3>) committed suicide', ctxWithDate())?.eventType).toBe('PLAYER_SUICIDE');
    const npc = parseAdmLine('18:10:00 | Player "Delta" (DEAD) (id=4 pos=<5,6,7>) killed by Wolf', ctxWithDate());
    expect(npc?.eventType).toBe('NPC_KILL');
    expect(npc?.targetName).toBe('Wolf');
  });

  it('klassifiziert nicht-toedlichen Vehicle-Hit nicht als Fahrzeug-Tod', () => {
    const hit = parseAdmLine('18:11:00 | Player "Echo" (id=5 pos=<8,9,10>) hit by [vehicle] OffroadHatchback at speed 35 km/h', ctxWithDate());
    expect(hit?.eventType).toBe('PLAYER_HIT');
    const fatal = parseAdmLine('18:11:01 | Player "Echo" (DEAD) (id=5 pos=<8,9,10>) hit by [vehicle] OffroadHatchback at speed 78 km/h', ctxWithDate());
    expect(fatal?.eventType).toBe('VEHICLE_DEATH');
  });

  it('parst Placement, Build, Dismantle und Destroy inklusive Werkzeug', () => {
    const placed = parseAdmLine('18:12:00 | Player "Echo" (id=5 pos=<8,9,10>) placed Fireplace', ctxWithDate());
    expect(placed?.eventType).toBe('PLACEMENT');
    expect(placed?.objectType).toBe('Fireplace');

    const built = parseAdmLine('18:13:00 | Player "Echo" (id=5 pos=<8,9,10>) built Fence with Shovel', ctxWithDate());
    expect(built?.eventType).toBe('BUILD');
    expect(built?.objectType).toBe('Fence');
    expect(built?.toolOrWeapon).toBe('Shovel');

    const dismantled = parseAdmLine('18:14:00 | Player "Echo" (id=5 pos=<8,9,10>) dismantled Fence with Hammer', ctxWithDate());
    expect(dismantled?.eventType).toBe('DISMANTLE');
    expect(dismantled?.objectType).toBe('Fence');
    expect(dismantled?.toolOrWeapon).toBe('Hammer');

    const destroyed = parseAdmLine('18:15:00 | Player "Echo" (id=5 pos=<8,9,10>) destroyed Watchtower with Hatchet', ctxWithDate());
    expect(destroyed?.eventType).toBe('DESTROY');
    expect(destroyed?.objectType).toBe('Watchtower');
    expect(destroyed?.toolOrWeapon).toBe('Hatchet');
  });

  it('PlayerList-Positionszeile', () => {
    const ev = parseAdmLine('12:00:00 | Player "Hotel"(id=76561190000000009) pos=<111.0, 222.0, 33.0>', ctxWithDate());
    expect(ev?.eventType).toBe('PLAYER_POSITION');
    expect(ev?.actorPosition).toBe('111.0, 222.0, 33.0');
  });

  it('DAYZ-GUID (Konsole) wird als actorGameId uebernommen', () => {
    const ev = parseAdmLine('09:00:10 | Player "Foxtrot"(id=ABCDEF0123456789ABCDEF0123456789) is connected', ctxWithDate());
    expect(ev?.actorGameId).toBe('ABCDEF0123456789ABCDEF0123456789');
  });

  it('ohne Basisdatum: occurredAt null + UNRESOLVED_TIMESTAMP', () => {
    const ev = parseAdmLine('18:00:12 | Player "Alpha"(id=1) is connected', newDateContext(null));
    expect(ev?.occurredAt).toBeNull();
    expect(ev?.parseStatus).toBe('UNRESOLVED_TIMESTAMP');
  });

  it('unbekannte Spielerzeile -> UNKNOWN, Nicht-Ereigniszeile -> null', () => {
    const unknown = parseAdmLine('18:00:00 | Player "Zulu"(id=9) did something undocumented xyz', ctxWithDate());
    expect(unknown?.eventType).toBe('UNKNOWN');
    expect(parseAdmLine('', ctxWithDate())).toBeNull();
    expect(parseAdmLine('   ', ctxWithDate())).toBeNull();
  });

  it('resolveBaseDate: Header und Dateiname-Fallback, sonst null', () => {
    expect(resolveBaseDate('AdminLog started on 2026-07-01 at 00:00:00')?.getUTCMonth()).toBe(6);
    expect(resolveBaseDate('no header', 'DayZServer_2026-07-05_00-00-00.ADM')?.getUTCDate()).toBe(5);
    expect(resolveBaseDate('no header', 'nofile.ADM')).toBeNull();
  });
});
