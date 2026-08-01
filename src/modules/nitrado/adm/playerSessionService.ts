/**
 * PlayerSessionService (Phase 3, Schritt 5) — Sitzungs-Aggregation + 10-Min-Buckets.
 *
 * Leitet aus normalisierten PLAYER_CONNECTED/PLAYER_DISCONNECTED-AdmEvents
 * Spielsitzungen ab. Idempotent: jede Sitzung ist an ihr Connect-Event
 * gebunden (PlayerSession.connectEventId ist unique) — dieselbe Connect-Zeile
 * erzeugt NIE zwei Sitzungen, egal wie oft der Sync laeuft.
 *
 * `bucketsEarned` = abgeschlossene 10-Minuten-Intervalle einer Sitzung. Das ist
 * die Grundlage fuer spaetere Spielzeitbelohnungen (Phase 5). Diese Schicht
 * bucht KEIN Geld — sie berechnet nur die Buckets. `bucketsCredited` wird erst
 * beim spaeteren Buchen erhoeht und verhindert dort Doppel-Gutschrift.
 */

export const BUCKET_SECONDS = 600; // 10 Minuten

export type SessionEventType = 'PLAYER_CONNECTED' | 'PLAYER_DISCONNECTED';

export interface SessionSourceEvent {
  id: string;
  eventType: SessionEventType;
  occurredAt: Date | null;
  actorGameId: string | null;
  actorName: string | null;
  sourceByteStart: bigint;
}

export type PlayerSessionStatus = 'OPEN' | 'CLOSED';

export interface PairedSession {
  gameId: string;
  playerName: string | null;
  connectEventId: string;
  disconnectEventId: string | null;
  connectedAt: Date | null;
  disconnectedAt: Date | null;
  durationSeconds: number;
  bucketsEarned: number;
  status: PlayerSessionStatus;
}

/** Abgeschlossene 10-Min-Buckets aus einer Dauer (Sekunden). Nie negativ. */
export function bucketsFromSeconds(durationSeconds: number): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0;
  return Math.floor(durationSeconds / BUCKET_SECONDS);
}

function sortKey(e: SessionSourceEvent): [number, bigint] {
  // occurredAt zuerst (null = Epoche 0, damit unaufloesbare Zeitstempel stabil
  // hinten/vorn sortieren), Byteposition als deterministischer Tie-Break.
  return [e.occurredAt ? e.occurredAt.getTime() : 0, e.sourceByteStart];
}

/**
 * Reine Paarung: connect -> naechstes disconnect je Spieler. Ein erneutes
 * connect ohne zwischenzeitliches disconnect schliesst die vorherige offene
 * Sitzung nicht kuenstlich (sie bleibt OPEN, durationSeconds 0). Ein disconnect
 * ohne offenes connect wird ignoriert (kein Sitzungsanfang bekannt).
 */
export function pairPlayerSessions(events: SessionSourceEvent[]): PairedSession[] {
  const byPlayer = new Map<string, SessionSourceEvent[]>();
  for (const e of events) {
    if (!e.actorGameId) continue; // ohne Identitaet keine Sitzung
    const list = byPlayer.get(e.actorGameId) ?? [];
    list.push(e);
    byPlayer.set(e.actorGameId, list);
  }

  const out: PairedSession[] = [];
  for (const [gameId, list] of byPlayer) {
    list.sort((a, b) => {
      const [at, ab] = sortKey(a);
      const [bt, bb] = sortKey(b);
      if (at !== bt) return at - bt;
      return ab < bb ? -1 : ab > bb ? 1 : 0;
    });

    let open: SessionSourceEvent | null = null;
    for (const e of list) {
      if (e.eventType === 'PLAYER_CONNECTED') {
        if (open) out.push(openSession(gameId, open)); // vorheriges connect blieb offen
        open = e;
      } else if (open) { // PLAYER_DISCONNECTED mit offenem connect
        out.push(closeSession(gameId, open, e));
        open = null;
      }
    }
    if (open) out.push(openSession(gameId, open));
  }
  return out;
}

function openSession(gameId: string, connect: SessionSourceEvent): PairedSession {
  return {
    gameId,
    playerName: connect.actorName,
    connectEventId: connect.id,
    disconnectEventId: null,
    connectedAt: connect.occurredAt,
    disconnectedAt: null,
    durationSeconds: 0,
    bucketsEarned: 0,
    status: 'OPEN',
  };
}

function closeSession(gameId: string, connect: SessionSourceEvent, disconnect: SessionSourceEvent): PairedSession {
  let durationSeconds = 0;
  if (connect.occurredAt && disconnect.occurredAt) {
    durationSeconds = Math.max(0, Math.round((disconnect.occurredAt.getTime() - connect.occurredAt.getTime()) / 1000));
  }
  return {
    gameId,
    playerName: connect.actorName ?? disconnect.actorName,
    connectEventId: connect.id,
    disconnectEventId: disconnect.id,
    connectedAt: connect.occurredAt,
    disconnectedAt: disconnect.occurredAt,
    durationSeconds,
    bucketsEarned: bucketsFromSeconds(durationSeconds),
    status: 'CLOSED',
  };
}

export interface PlayerSessionScope {
  guildId: string;
  nitradoConnId: string;
}

/** Prisma-Teilschnittstelle (fuer Testbarkeit ohne echten Client). */
export interface PlayerSessionClient {
  admEvent: {
    findMany: (args: unknown) => Promise<SessionSourceEvent[]>;
  };
  playerSession: {
    upsert: (args: { where: Record<string, unknown>; create: Record<string, unknown>; update: Record<string, unknown> }) => Promise<unknown>;
  };
}

/**
 * Baut/aktualisiert PlayerSessions aus den Connect/Disconnect-Events eines
 * Slots. Idempotent ueber connectEventId (unique). Eine zuvor OPEN gebuchte
 * Sitzung wird beim spaeteren Auftauchen ihres Disconnects auf CLOSED
 * aktualisiert; bucketsCredited bleibt unangetastet (kein Reset).
 */
export async function aggregatePlayerSessions(
  client: PlayerSessionClient,
  scope: PlayerSessionScope,
  limit = 2000,
): Promise<{ upserted: number; closed: number; open: number }> {
  const events = await client.admEvent.findMany({
    where: {
      guildId: scope.guildId,
      nitradoConnId: scope.nitradoConnId,
      eventType: { in: ['PLAYER_CONNECTED', 'PLAYER_DISCONNECTED'] },
    },
    orderBy: { occurredAt: 'asc' },
    take: limit,
  });

  const sessions = pairPlayerSessions(events);
  let upserted = 0, closed = 0, open = 0;
  for (const s of sessions) {
    await client.playerSession.upsert({
      where: { connectEventId: s.connectEventId },
      create: {
        guildId: scope.guildId,
        nitradoConnId: scope.nitradoConnId,
        gameId: s.gameId,
        playerName: s.playerName,
        connectEventId: s.connectEventId,
        disconnectEventId: s.disconnectEventId,
        connectedAt: s.connectedAt,
        disconnectedAt: s.disconnectedAt,
        durationSeconds: s.durationSeconds,
        bucketsEarned: s.bucketsEarned,
        status: s.status,
      },
      // Nur die Sitzungs-Endedaten aktualisieren; bucketsCredited NICHT anfassen.
      update: {
        playerName: s.playerName,
        disconnectEventId: s.disconnectEventId,
        disconnectedAt: s.disconnectedAt,
        durationSeconds: s.durationSeconds,
        bucketsEarned: s.bucketsEarned,
        status: s.status,
      },
    });
    upserted++;
    if (s.status === 'CLOSED') closed++; else open++;
  }
  return { upserted, closed, open };
}
