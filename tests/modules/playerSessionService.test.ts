/**
 * Phase 3, Schritt 5: PlayerSession-Aggregation + 10-Min-Buckets.
 * Kernbeweis: dieselbe Connect-Zeile erzeugt NIE zwei Sitzungen
 * (Idempotenz ueber connectEventId) und Buckets zaehlen abgeschlossene
 * 10-Minuten-Intervalle.
 */
import {
  bucketsFromSeconds, pairPlayerSessions, aggregatePlayerSessions,
  BUCKET_SECONDS, type SessionSourceEvent, type PlayerSessionClient,
} from '../../src/modules/nitrado/adm/playerSessionService';

function ev(
  id: string,
  eventType: 'PLAYER_CONNECTED' | 'PLAYER_DISCONNECTED',
  gameId: string | null,
  occurredAt: Date | null,
  byte: bigint,
  name: string | null = 'Spieler',
): SessionSourceEvent {
  return { id, eventType, actorGameId: gameId, actorName: name, occurredAt, sourceByteStart: byte };
}

describe('bucketsFromSeconds', () => {
  it('rechnet volle 10-Min-Buckets, Reste verfallen', () => {
    expect(bucketsFromSeconds(0)).toBe(0);
    expect(bucketsFromSeconds(BUCKET_SECONDS - 1)).toBe(0);
    expect(bucketsFromSeconds(BUCKET_SECONDS)).toBe(1);
    expect(bucketsFromSeconds(BUCKET_SECONDS * 3 + 59)).toBe(3);
  });
  it('nie negativ bei ungueltiger Dauer', () => {
    expect(bucketsFromSeconds(-100)).toBe(0);
    expect(bucketsFromSeconds(NaN)).toBe(0);
  });
});

describe('pairPlayerSessions', () => {
  const t = (min: number): Date => new Date(Date.UTC(2026, 0, 1, 12, min, 0));

  it('paart connect->disconnect zu einer CLOSED-Sitzung mit Dauer+Buckets', () => {
    const sessions = pairPlayerSessions([
      ev('c1', 'PLAYER_CONNECTED', 'p1', t(0), 10n),
      ev('d1', 'PLAYER_DISCONNECTED', 'p1', t(35), 200n),
    ]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].status).toBe('CLOSED');
    expect(sessions[0].connectEventId).toBe('c1');
    expect(sessions[0].disconnectEventId).toBe('d1');
    expect(sessions[0].durationSeconds).toBe(35 * 60);
    expect(sessions[0].bucketsEarned).toBe(3);
  });

  it('offenes connect ohne disconnect bleibt OPEN mit Dauer 0', () => {
    const sessions = pairPlayerSessions([ev('c1', 'PLAYER_CONNECTED', 'p1', t(0), 10n)]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].status).toBe('OPEN');
    expect(sessions[0].durationSeconds).toBe(0);
    expect(sessions[0].bucketsEarned).toBe(0);
  });

  it('zweites connect ohne disconnect laesst erstes OPEN und oeffnet neues', () => {
    const sessions = pairPlayerSessions([
      ev('c1', 'PLAYER_CONNECTED', 'p1', t(0), 10n),
      ev('c2', 'PLAYER_CONNECTED', 'p1', t(20), 300n),
      ev('d2', 'PLAYER_DISCONNECTED', 'p1', t(45), 500n),
    ]);
    expect(sessions).toHaveLength(2);
    const open = sessions.find(s => s.connectEventId === 'c1')!;
    const closed = sessions.find(s => s.connectEventId === 'c2')!;
    expect(open.status).toBe('OPEN');
    expect(closed.status).toBe('CLOSED');
    expect(closed.durationSeconds).toBe(25 * 60);
  });

  it('disconnect ohne offenes connect wird ignoriert', () => {
    const sessions = pairPlayerSessions([ev('d1', 'PLAYER_DISCONNECTED', 'p1', t(5), 10n)]);
    expect(sessions).toHaveLength(0);
  });

  it('trennt Sitzungen pro Spieler', () => {
    const sessions = pairPlayerSessions([
      ev('c1', 'PLAYER_CONNECTED', 'p1', t(0), 10n),
      ev('c2', 'PLAYER_CONNECTED', 'p2', t(1), 20n),
      ev('d1', 'PLAYER_DISCONNECTED', 'p1', t(15), 30n),
      ev('d2', 'PLAYER_DISCONNECTED', 'p2', t(31), 40n),
    ]);
    expect(sessions).toHaveLength(2);
    expect(sessions.find(s => s.gameId === 'p1')!.bucketsEarned).toBe(1);
    expect(sessions.find(s => s.gameId === 'p2')!.bucketsEarned).toBe(3);
  });

  it('ignoriert Events ohne Spieler-ID', () => {
    const sessions = pairPlayerSessions([ev('c1', 'PLAYER_CONNECTED', null, t(0), 10n)]);
    expect(sessions).toHaveLength(0);
  });

  it('unaufloesbare Zeitstempel -> Dauer 0', () => {
    const sessions = pairPlayerSessions([
      ev('c1', 'PLAYER_CONNECTED', 'p1', null, 10n),
      ev('d1', 'PLAYER_DISCONNECTED', 'p1', null, 20n),
    ]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].durationSeconds).toBe(0);
  });
});

describe('aggregatePlayerSessions — Idempotenz', () => {
  const t = (min: number): Date => new Date(Date.UTC(2026, 0, 1, 12, min, 0));

  function makeClient(events: SessionSourceEvent[]) {
    const store = new Map<string, Record<string, unknown>>();
    const client: PlayerSessionClient = {
      admEvent: { findMany: async () => events },
      playerSession: {
        upsert: async ({ where, create, update }) => {
          const key = where.connectEventId as string;
          if (store.has(key)) {
            store.set(key, { ...store.get(key)!, ...update });
          } else {
            store.set(key, { ...create });
          }
          return store.get(key);
        },
      },
    };
    return { client, store };
  }

  it('zweiter Lauf erzeugt keine Duplikate (upsert je connectEventId)', async () => {
    const events = [
      ev('c1', 'PLAYER_CONNECTED', 'p1', t(0), 10n),
      ev('d1', 'PLAYER_DISCONNECTED', 'p1', t(35), 200n),
    ];
    const { client, store } = makeClient(events);
    const r1 = await aggregatePlayerSessions(client, { guildId: 'g', nitradoConnId: 'n' });
    const r2 = await aggregatePlayerSessions(client, { guildId: 'g', nitradoConnId: 'n' });
    expect(r1.upserted).toBe(1);
    expect(r1.closed).toBe(1);
    expect(r2.upserted).toBe(1);
    expect(store.size).toBe(1);
    expect(store.get('c1')!.bucketsEarned).toBe(3);
  });

  it('spaeteres disconnect schliesst eine zuvor OPEN gebuchte Sitzung', async () => {
    const first = makeClient([ev('c1', 'PLAYER_CONNECTED', 'p1', t(0), 10n)]);
    await aggregatePlayerSessions(first.client, { guildId: 'g', nitradoConnId: 'n' });
    expect(first.store.get('c1')!.status).toBe('OPEN');

    // Neuer Lauf sieht jetzt auch das Disconnect; gleicher Store simuliert DB.
    const withDc: PlayerSessionClient = {
      admEvent: { findMany: async () => [
        ev('c1', 'PLAYER_CONNECTED', 'p1', t(0), 10n),
        ev('d1', 'PLAYER_DISCONNECTED', 'p1', t(25), 200n),
      ] },
      playerSession: {
        upsert: async ({ where, create, update }) => {
          const key = where.connectEventId as string;
          if (first.store.has(key)) first.store.set(key, { ...first.store.get(key)!, ...update });
          else first.store.set(key, { ...create });
          return first.store.get(key);
        },
      },
    };
    await aggregatePlayerSessions(withDc, { guildId: 'g', nitradoConnId: 'n' });
    expect(first.store.get('c1')!.status).toBe('CLOSED');
    expect(first.store.get('c1')!.durationSeconds).toBe(25 * 60);
    expect(first.store.get('c1')!.bucketsEarned).toBe(2);
  });
});
