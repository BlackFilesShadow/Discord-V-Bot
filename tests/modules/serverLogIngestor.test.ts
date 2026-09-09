/**
 * Phase 3, Schritt 2: ServerLogIngestor — byte-genauer Cursor.
 * Prueft KILL-001 (keine verlorene erste Zeile), Truncation, Teilzeilen,
 * Idempotenz (eventKey) und atomare Persistierung.
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
  function makeClient() {
    const seen = new Set<string>();
    const calls = { createMany: 0, upsert: 0 };
    let lastRows: unknown[] = [];
    let lastCursorArgs: unknown = null;
    const client: AdmPersistClient = {
      admEvent: {
        createMany: async ({ data, skipDuplicates }) => {
          calls.createMany++;
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
        upsert: async (args) => {
          calls.upsert++;
          lastCursorArgs = args;
          return {};
        },
      },
      $transaction: async (fn) => fn(client),
    };
    return {
      client,
      calls,
      get lastRows() { return lastRows; },
      get lastCursorArgs() { return lastCursorArgs; },
    };
  }

  it('zweifache Persistierung derselben Events fuegt nur einmal ein (Idempotenz)', async () => {
    const content = fixture('vanilla_pc.ADM');
    const res: IngestResult = ingestFullFile(content, 0, { fileName: 'vanilla_pc.ADM' });
    const holder = makeClient();
    const scope = { guildId: 'g1', nitradoConnId: 'c1' };
    const meta = { fileIdentity: 'fid', fileName: 'vanilla_pc.ADM', lastModifiedAt: 1, fileSize: 999 };

    const r1 = await persistAdmEvents(holder.client, scope, meta, res, 'fp');
    const r2 = await persistAdmEvents(holder.client, scope, meta, res, 'fp');
    expect(r1.inserted).toBe(10);
    expect(r2.inserted).toBe(0);
    expect(holder.calls.upsert).toBe(2); // Cursor immer aktualisiert
  });

  it('trennt namespaceten Event-Source-Key vom echten Cursor-Dateinamen', async () => {
    const content = 'AdminLog started on 2026-07-01 at 18:00:00\n18:00:12 | Player "Alpha"(id=1) is connected\n';
    const res = ingestFullFile(content, 0, { fileName: 'DayZServer.ADM' });
    const holder = makeClient();
    const sourceIdentity = 'adm-binding:2:DayZServer.ADM';

    await persistAdmEvents(
      holder.client,
      { guildId: 'g1', nitradoConnId: 'c1' },
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

  it('persistiert grosse ADM-Mengen in begrenzten Batches und zaehlt alle Inserts', async () => {
    const header = 'AdminLog started on 2026-07-01 at 18:00:00\n';
    const lines = Array.from(
      { length: 600 },
      (_, index) => `18:00:12 | Player "Player ${index}"(id=player-${index}) is connected\n`,
    ).join('');
    const res = ingestFullFile(header + lines, 0, { fileName: 'capacity.ADM' });
    expect(res.events).toHaveLength(600);

    const batchSizes: number[] = [];
    let cursorWrites = 0;
    const client: AdmPersistClient = {
      admEvent: {
        createMany: async ({ data }) => {
          batchSizes.push(data.length);
          return { count: data.length };
        },
      },
      admSourceCursor: {
        upsert: async () => {
          cursorWrites++;
          return {};
        },
      },
      $transaction: async (fn) => fn(client),
    };

    const result = await persistAdmEvents(
      client,
      { guildId: 'capacity-g', nitradoConnId: 'capacity-n' },
      { fileIdentity: 'capacity-fid', fileName: 'capacity.ADM', lastModifiedAt: 1, fileSize: Buffer.byteLength(header + lines) },
      res,
      'capacity-fp',
    );

    expect(result.inserted).toBe(600);
    expect(batchSizes).toEqual([250, 250, 100]);
    expect(cursorWrites).toBe(1);
  });

  it('schreibt den Cursor nicht, wenn ein spaeter Persistenz-Batch fehlschlaegt', async () => {
    const header = 'AdminLog started on 2026-07-01 at 18:00:00\n';
    const lines = Array.from(
      { length: 300 },
      (_, index) => `18:00:12 | Player "Player ${index}"(id=player-${index}) is connected\n`,
    ).join('');
    const res = ingestFullFile(header + lines, 0, { fileName: 'capacity-fail.ADM' });
    let createManyCalls = 0;
    let cursorWrites = 0;
    const client: AdmPersistClient = {
      admEvent: {
        createMany: async ({ data }) => {
          createManyCalls++;
          if (createManyCalls === 2) throw new Error('synthetic batch failure');
          return { count: data.length };
        },
      },
      admSourceCursor: {
        upsert: async () => {
          cursorWrites++;
          return {};
        },
      },
      $transaction: async (fn) => fn(client),
    };

    await expect(persistAdmEvents(
      client,
      { guildId: 'capacity-g', nitradoConnId: 'capacity-n' },
      { fileIdentity: 'capacity-fail-fid', fileName: 'capacity-fail.ADM', lastModifiedAt: 1, fileSize: Buffer.byteLength(header + lines) },
      res,
      'capacity-fail-fp',
    )).rejects.toThrow('synthetic batch failure');

    expect(createManyCalls).toBe(2);
    expect(cursorWrites).toBe(0);
  });
});
