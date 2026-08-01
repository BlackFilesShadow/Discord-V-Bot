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
    const client: AdmPersistClient = {
      admEvent: {
        createMany: async ({ data, skipDuplicates }) => {
          calls.createMany++;
          let count = 0;
          for (const row of data as Array<{ eventKey: string }>) {
            if (skipDuplicates && seen.has(row.eventKey)) continue;
            seen.add(row.eventKey);
            count++;
          }
          return { count };
        },
      },
      admSourceCursor: { upsert: async () => { calls.upsert++; return {}; } },
      $transaction: async (fn) => fn(client),
    };
    return { client, calls };
  }

  it('zweifache Persistierung derselben Events fuegt nur einmal ein (Idempotenz)', async () => {
    const content = fixture('vanilla_pc.ADM');
    const res: IngestResult = ingestFullFile(content, 0, { fileName: 'vanilla_pc.ADM' });
    const { client, calls } = makeClient();
    const scope = { guildId: 'g1', nitradoConnId: 'c1' };
    const meta = { fileIdentity: 'fid', fileName: 'vanilla_pc.ADM', lastModifiedAt: 1, fileSize: 999 };

    const r1 = await persistAdmEvents(client, scope, meta, res, 'fp');
    const r2 = await persistAdmEvents(client, scope, meta, res, 'fp');
    expect(r1.inserted).toBe(10);
    expect(r2.inserted).toBe(0);
    expect(calls.upsert).toBe(2); // Cursor immer aktualisiert
  });
});
