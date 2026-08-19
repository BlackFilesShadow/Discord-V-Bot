/**
 * Phase 3, Schritt 2: ServerLogIngestor — byte-genauer Cursor.
 * Prueft KILL-001 (keine verlorene erste Zeile), Truncation, Teilzeilen,
 * Idempotenz (eventKey), Replica-Fencing und atomare Persistierung.
 */
import fs from 'fs';
import path from 'path';
import {
  ingestFullFile,
  computeEventKey,
  persistAdmEvents,
  type AdmPersistClient,
  type IngestResult,
} from '../../src/modules/nitrado/adm/serverLogIngestor';

const FIX = path.join(__dirname, '..', 'fixtures', 'adm');
function fixture(name: string): string {
  return fs.readFileSync(path.join(FIX, name), 'utf8');
}

describe('serverLogIngestor — Byte-Cursor', () => {
  it('verarbeitet die ganze Datei ab Offset 0; Offset landet am Dateiende', () => {
    const content = fixture('vanilla_pc.ADM');
    const res = ingestFullFile(content, 0, { fileName: 'vanilla_pc.ADM' });
    expect(res.events.length).toBe(10); // Header zaehlt nicht
    expect(res.newOffset).toBe(Buffer.byteLength(content, 'utf8'));
    expect(res.trailingPartial).toBe('');
    expect(res.wasReset).toBe(false);
  });

  it('erneutes Ingest ab newOffset liefert keine neuen Events (idempotent am Cursor)', () => {
    const content = fixture('vanilla_pc.ADM');
    const first = ingestFullFile(content, 0);
    const again = ingestFullFile(content, first.newOffset);
    expect(again.events.length).toBe(0);
  });

  it('KILL-001: Ingest ab exakter Zeilengrenze verliert die erste neue Zeile NICHT', () => {
    const content = fixture('vanilla_pc.ADM');
    const first = ingestFullFile(content, 0, { fileName: 'vanilla_pc.ADM' });
    const killEvent = first.events[2]; // erster Kill (Opfer Bravo)
    expect(killEvent.eventType).toBe('PLAYER_KILLED');
    const fromBoundary = ingestFullFile(content, killEvent.byteStart, { fileName: 'vanilla_pc.ADM' });
    // Die erste zurueckgegebene Zeile MUSS der Kill sein, nicht die naechste.
    expect(fromBoundary.events[0].eventType).toBe('PLAYER_KILLED');
    expect(fromBoundary.events[0].actorName).toBe('Bravo');
  });

  it('Truncation: Offset groesser als Datei -> Reset auf 0', () => {
    const content = fixture('playerlist.ADM');
    const res = ingestFullFile(content, 10_000);
    expect(res.wasReset).toBe(true);
    expect(res.events.length).toBeGreaterThan(0);
  });

  it('unvollstaendige letzte Zeile wird gepuffert, nicht verarbeitet', () => {
    const header = 'AdminLog started on 2026-07-01 at 18:00:00\n';
    const line1 = '18:00:12 | Player "Alpha"(id=1) is connected\n';
    const partial = '18:00:20 | Player "Bravo"(id=2) is conn'; // ohne \n
    const content = header + line1 + partial;
    const res = ingestFullFile(content, 0);
    expect(res.events.length).toBe(1); // nur die vollstaendige connect-Zeile
    expect(res.trailingPartial).toBe(partial);
    expect(res.newOffset).toBe(Buffer.byteLength(header + line1, 'utf8'));

    // Zeile wird spaeter vollstaendig -> jetzt verarbeitet
    const completed = content + 'ected\n';
    const res2 = ingestFullFile(completed, res.newOffset);
    expect(res2.events.length).toBe(1);
    expect(res2.events[0].eventType).toBe('PLAYER_CONNECTED');
    expect(res2.events[0].actorName).toBe('Bravo');
  });

  it('computeEventKey ist deterministisch und positionssensitiv', () => {
    const k1 = computeEventKey('g', 'c', 'file', 100, 'line');
    const k2 = computeEventKey('g', 'c', 'file', 100, 'line');
    const k3 = computeEventKey('g', 'c', 'file', 101, 'line');
    expect(k1).toBe(k2);
    expect(k1).not.toBe(k3);
    expect(k1).toHaveLength(64);
  });
});

describe('serverLogIngestor — atomare Persistierung', () => {
  interface CursorState {
    lastModifiedAt: number;
    lastKnownSize: bigint;
    processedByteOffset: bigint;
    trailingPartialLine: string | null;
    contentFingerprint: string | null;
  }

  function makeClient() {
    const seen = new Set<string>();
    const calls = { createMany: 0, upsert: 0, findUnique: 0, advisoryLock: 0 };
    const sequence: string[] = [];
    let lastRows: unknown[] = [];
    let lastCursorArgs: unknown = null;
    let cursor: CursorState | null = null;

    const client: AdmPersistClient = {
      admEvent: {
        createMany: async ({ data, skipDuplicates }) => {
          calls.createMany++;
          sequence.push('events');
          lastRows = data;
          let count = 0;
          for (const row of data as Array<{ eventKey: string }>) {
            if (skipDuplicates && seen.has(row.eventKey)) continue;
            seen.add(row.eventKey);
            count++;
          }
          return { count };
        },
      },
      admSourceCursor: {
        findUnique: async () => {
          calls.findUnique++;
          sequence.push('cursor-read');
          return cursor ? { ...cursor } : null;
        },
        upsert: async (args: unknown) => {
          calls.upsert++;
          sequence.push('cursor-write');
          lastCursorArgs = args;
          const typed = args as {
            create: {
              lastModifiedAt: number;
              lastKnownSize: bigint;
              processedByteOffset: bigint;
              trailingPartialLine: string | null;
              contentFingerprint: string | null;
            };
            update: {
              lastModifiedAt: number;
              lastKnownSize: bigint;
              processedByteOffset: bigint;
              trailingPartialLine: string | null;
              contentFingerprint: string | null;
            };
          };
          const data = cursor ? typed.update : typed.create;
          cursor = {
            lastModifiedAt: data.lastModifiedAt,
            lastKnownSize: data.lastKnownSize,
            processedByteOffset: data.processedByteOffset,
            trailingPartialLine: data.trailingPartialLine,
            contentFingerprint: data.contentFingerprint,
          };
          return {};
        },
      },
      $queryRawUnsafe: async <T = unknown>(query: string, ...values: unknown[]): Promise<T> => {
        calls.advisoryLock++;
        sequence.push('lock');
        expect(query).toContain('pg_advisory_xact_lock(hashtextextended($1, 0))');
        expect(values).toEqual(['adm-persist:g1:c1:fid']);
        return [] as T;
      },
      $transaction: async (fn) => fn(client),
    };
    return {
      client,
      calls,
      sequence,
      get lastRows() { return lastRows; },
      get lastCursorArgs() { return lastCursorArgs; },
      get cursor() { return cursor; },
    };
  }

  const scope = { guildId: 'g1', nitradoConnId: 'c1' };
  const meta = { fileIdentity: 'fid', fileName: 'vanilla_pc.ADM', lastModifiedAt: 1, fileSize: 999 };

  it('zweifache Persistierung derselben Events fuegt nur einmal ein (Idempotenz)', async () => {
    const content = fixture('vanilla_pc.ADM');
    const res: IngestResult = ingestFullFile(content, 0, { fileName: 'vanilla_pc.ADM' });
    const holder = makeClient();

    const r1 = await persistAdmEvents(holder.client, scope, meta, res, 'fp');
    const r2 = await persistAdmEvents(holder.client, scope, meta, res, 'fp');
    expect(r1.inserted).toBe(10);
    expect(r2.inserted).toBe(0);
    expect(holder.calls.upsert).toBe(2);
    expect(holder.calls.advisoryLock).toBe(2);
  });

  it('nimmt den DB-weiten Datei-Lock vor Cursor-Read, Event-Write und Cursor-Write', async () => {
    const content = 'AdminLog started on 2026-07-01 at 18:00:00\n18:00:12 | Player "Alpha"(id=1) is connected\n';
    const res = ingestFullFile(content, 0, { fileName: meta.fileName });
    const holder = makeClient();

    await persistAdmEvents(holder.client, scope, { ...meta, fileSize: Buffer.byteLength(content) }, res, 'fp');

    expect(holder.sequence).toEqual(['lock', 'cursor-read', 'events', 'cursor-write']);
  });

  it('verwirft einen aelteren Replica-Snapshot komplett vor Event- und Cursor-Write', async () => {
    const holder = makeClient();
    const fresh: IngestResult = { events: [], newOffset: 400, trailingPartial: '', wasReset: false };
    await persistAdmEvents(holder.client, scope, { ...meta, lastModifiedAt: 20, fileSize: 500 }, fresh, 'fresh');

    const staleContent = '18:00:12 | Player "Stale"(id=stale-id) is connected\n';
    const stale = ingestFullFile(staleContent, 0, { fileName: meta.fileName });
    const beforeCreates = holder.calls.createMany;
    const beforeWrites = holder.calls.upsert;
    const result = await persistAdmEvents(
      holder.client,
      scope,
      { ...meta, lastModifiedAt: 10, fileSize: Buffer.byteLength(staleContent) },
      stale,
      'stale',
    );

    expect(result).toEqual({ inserted: 0 });
    expect(holder.calls.createMany).toBe(beforeCreates);
    expect(holder.calls.upsert).toBe(beforeWrites);
    expect(holder.cursor).toMatchObject({
      lastModifiedAt: 20,
      lastKnownSize: 500n,
      processedByteOffset: 400n,
      contentFingerprint: 'fresh',
    });
  });

  it('laesst bei gleicher mtime weder kleinere Datei noch niedrigeren Offset den Cursor regressieren', async () => {
    const holder = makeClient();
    await persistAdmEvents(
      holder.client,
      scope,
      { ...meta, lastModifiedAt: 30, fileSize: 500 },
      { events: [], newOffset: 400, trailingPartial: '', wasReset: false },
      'base',
    );
    const beforeWrites = holder.calls.upsert;

    await persistAdmEvents(
      holder.client,
      scope,
      { ...meta, lastModifiedAt: 30, fileSize: 300 },
      { events: [], newOffset: 250, trailingPartial: '', wasReset: false },
      'smaller',
    );
    await persistAdmEvents(
      holder.client,
      scope,
      { ...meta, lastModifiedAt: 30, fileSize: 600 },
      { events: [], newOffset: 350, trailingPartial: '', wasReset: false },
      'lower-offset',
    );

    expect(holder.calls.upsert).toBe(beforeWrites);
    expect(holder.cursor).toMatchObject({ lastKnownSize: 500n, processedByteOffset: 400n });
  });

  it('akzeptiert eine nachweislich neuere Dateitruncation und setzt den Cursor kontrolliert zurueck', async () => {
    const holder = makeClient();
    await persistAdmEvents(
      holder.client,
      scope,
      { ...meta, lastModifiedAt: 40, fileSize: 500 },
      { events: [], newOffset: 450, trailingPartial: '', wasReset: false },
      'old-file',
    );

    await persistAdmEvents(
      holder.client,
      scope,
      { ...meta, lastModifiedAt: 41, fileSize: 100 },
      { events: [], newOffset: 80, trailingPartial: 'partial', wasReset: false },
      'new-file',
    );

    expect(holder.cursor).toMatchObject({
      lastModifiedAt: 41,
      lastKnownSize: 100n,
      processedByteOffset: 80n,
      trailingPartialLine: 'partial',
      contentFingerprint: 'new-file',
    });
  });

  it('trennt namespaceten Event-Source-Key vom echten Cursor-Dateinamen', async () => {
    const content = 'AdminLog started on 2026-07-01 at 18:00:00\n18:00:12 | Player "Alpha"(id=1) is connected\n';
    const res = ingestFullFile(content, 0, { fileName: 'DayZServer.ADM' });
    const holder = makeClient();
    const sourceIdentity = 'adm-binding:2:DayZServer.ADM';

    // Dieser Test benutzt eine andere fileIdentity; der Mock prueft den Lock-Key
    // deshalb separat mit einem lokalen Wrapper statt den Standard-'fid'-Key.
    const originalRaw = holder.client.$queryRawUnsafe;
    holder.client.$queryRawUnsafe = async <T = unknown>(query: string, ...values: unknown[]): Promise<T> => {
      expect(query).toContain('pg_advisory_xact_lock(hashtextextended($1, 0))');
      expect(values).toEqual([`adm-persist:g1:c1:${sourceIdentity}`]);
      return [] as T;
    };

    await persistAdmEvents(
      holder.client,
      scope,
      {
        fileIdentity: sourceIdentity,
        fileName: 'DayZServer.ADM',
        sourceFile: sourceIdentity,
        lastModifiedAt: 1,
        fileSize: Buffer.byteLength(content, 'utf8'),
      },
      res,
      'fp',
    );
    holder.client.$queryRawUnsafe = originalRaw;

    expect(holder.lastRows).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceFile: sourceIdentity }),
    ]));
    expect(holder.lastCursorArgs).toEqual(expect.objectContaining({
      create: expect.objectContaining({
        fileIdentity: sourceIdentity,
        fileName: 'DayZServer.ADM',
      }),
      update: expect.objectContaining({ fileName: 'DayZServer.ADM' }),
    }));
  });
});
