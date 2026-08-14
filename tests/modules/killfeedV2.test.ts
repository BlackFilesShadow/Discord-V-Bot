/**
 * Killfeed V2: Ableitung aus AdmEvent + idempotente Zustellung.
 * Kernbeweise: rohe Koordinaten + Schalter, Killer immer angezeigt (auch
 * unverlinkt), pro Config genau eine Zustellung je AdmEvent und Realtime-Hook
 * nur fuer tatsaechlich neu geclaimte Events.
 */
import {
  mapEventToCategory, deriveKillfeedView, claimDelivery, deliverPendingKills,
  type KillAdmEvent, type KillfeedConfigRow, type DeliverClient,
} from '../../src/modules/killfeed/killfeedV2';

const CFG = {
  showShooterCoords: false, showVictimCoords: true, showWeapon: true, showDistance: true,
};

function ev(over: Partial<KillAdmEvent> = {}): KillAdmEvent {
  return {
    id: 'e1', eventType: 'PLAYER_KILLED', occurredAt: new Date('2026-08-01T12:00:00Z'),
    actorGameId: 'victimId', actorName: 'Opfer', targetGameId: 'killerId', targetName: 'Killer',
    toolOrWeapon: 'M4A1', distanceMeters: 123.4, actorPosition: '100.0 200.0 300.0', targetPosition: '400.0 500.0 600.0',
    ...over,
  };
}

describe('mapEventToCategory', () => {
  it('mappt Kill-Typen', () => {
    expect(mapEventToCategory('PLAYER_KILLED')).toBe('DEATH');
    expect(mapEventToCategory('PLAYER_SUICIDE')).toBe('SUICIDE');
    expect(mapEventToCategory('NPC_KILL')).toBe('NPC');
    expect(mapEventToCategory('VEHICLE_DEATH')).toBe('VEHICLE');
    expect(mapEventToCategory('PLAYER_CONNECTED')).toBeNull();
  });
});

describe('deriveKillfeedView', () => {
  it('actor=Opfer, target=Killer; rohe Opfer-Coords, Killer-Coords aus (default)', () => {
    const v = deriveKillfeedView(ev(), CFG)!;
    expect(v.victimName).toBe('Opfer');
    expect(v.victimGameId).toBe('victimId');
    expect(v.killerName).toBe('Killer');
    expect(v.killerGameId).toBe('killerId');
    expect(v.victimPos).toBe('100.0 200.0 300.0');
    expect(v.killerPos).toBeNull();
    expect(v.weapon).toBe('M4A1');
    expect(v.distanceMeters).toBe(123.4);
  });

  it('Killer wird auch ohne Ziel-GameId (unverlinkt) angezeigt', () => {
    const v = deriveKillfeedView(ev({ targetGameId: null, targetName: 'Killer' }), CFG)!;
    expect(v.killerName).toBe('Killer');
    expect(v.killerGameId).toBeNull();
  });

  it('Schalter aus -> Felder null', () => {
    const v = deriveKillfeedView(ev(), { showShooterCoords: false, showVictimCoords: false, showWeapon: false, showDistance: false })!;
    expect(v.victimPos).toBeNull();
    expect(v.weapon).toBeNull();
    expect(v.distanceMeters).toBeNull();
  });

  it('Killer-Coords nur wenn showShooterCoords', () => {
    const v = deriveKillfeedView(ev(), { ...CFG, showShooterCoords: true })!;
    expect(v.killerPos).toBe('400.0 500.0 600.0');
  });

  it('Nicht-Kill-Event -> null', () => {
    expect(deriveKillfeedView(ev({ eventType: 'PLAYER_CONNECTED' }), CFG)).toBeNull();
  });
});

function makeClient(events: KillAdmEvent[]) {
  const delivered = new Set<string>();
  const messages = new Map<string, string>();
  const client: DeliverClient = {
    admEvent: { findMany: async () => events },
    killfeedDelivery: {
      create: async ({ data }) => {
        const key = `${data.configId}:${data.admEventId}`;
        if (delivered.has(key)) { const e = new Error('u') as Error & { code: string }; e.code = 'P2002'; throw e; }
        delivered.add(key);
        return { id: 'del-' + key };
      },
      update: async ({ where, data }) => { messages.set(where.id as string, data.messageId as string); return {}; },
    },
  };
  return { client, delivered, messages };
}

const CONFIG: KillfeedConfigRow = {
  id: 'cfg1', guildId: 'g', nitradoConnId: 'n', channelId: '123',
  showShooterCoords: false, showVictimCoords: true, showWeapon: true, showDistance: true,
};

describe('claimDelivery / deliverPendingKills — Idempotenz', () => {
  it('claim einmal true, danach false', async () => {
    const { client } = makeClient([]);
    const a = await claimDelivery(client, { configId: 'c', admEventId: 'e', guildId: 'g', channelId: '1' });
    const b = await claimDelivery(client, { configId: 'c', admEventId: 'e', guildId: 'g', channelId: '1' });
    expect(a.claimed).toBe(true);
    expect(b.claimed).toBe(false);
  });

  it('stellt jedes Event genau einmal zu', async () => {
    const { client, messages } = makeClient([ev({ id: 'e1' }), ev({ id: 'e2' })]);
    const poster = jest.fn().mockResolvedValue('msg-1');
    const r1 = await deliverPendingKills(client, CONFIG, poster);
    const r2 = await deliverPendingKills(client, CONFIG, poster);
    expect(r1.delivered).toBe(2);
    expect(r2.delivered).toBe(0);
    expect(poster).toHaveBeenCalledTimes(2);
    expect(messages.size).toBe(2);
  });

  it('Realtime-Hook laeuft ebenfalls nur fuer neu geclaimte Events', async () => {
    const { client } = makeClient([ev({ id: 'e1' }), ev({ id: 'e2' })]);
    const poster = jest.fn().mockResolvedValue('msg');
    const onDelivered = jest.fn();
    await deliverPendingKills(client, CONFIG, poster, { onDelivered });
    await deliverPendingKills(client, CONFIG, poster, { onDelivered });
    expect(onDelivered).toHaveBeenCalledTimes(2);
    expect(onDelivered.mock.calls.map((c) => (c[0] as KillAdmEvent).id)).toEqual(['e1', 'e2']);
  });

  it('Realtime-Fehler erzeugt keine erneute persistente Zustellung', async () => {
    const { client } = makeClient([ev({ id: 'e1' })]);
    const poster = jest.fn().mockResolvedValue('msg');
    const onDelivered = jest.fn().mockRejectedValue(new Error('socket down'));
    const first = await deliverPendingKills(client, CONFIG, poster, { onDelivered });
    const second = await deliverPendingKills(client, CONFIG, poster, { onDelivered });
    expect(first.delivered).toBe(1);
    expect(second.delivered).toBe(0);
    expect(poster).toHaveBeenCalledTimes(1);
  });

  it('ueberspringt Nicht-Kill-Events (kein Claim, kein Post)', async () => {
    const { client } = makeClient([ev({ id: 'e1', eventType: 'PLAYER_CONNECTED' })]);
    const poster = jest.fn().mockResolvedValue('m');
    const r = await deliverPendingKills(client, CONFIG, poster);
    expect(r.delivered).toBe(0);
    expect(poster).not.toHaveBeenCalled();
  });
});
