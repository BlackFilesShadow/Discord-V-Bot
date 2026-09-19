import {
  persistAdmEvents,
  type AdmPersistClient,
  type AdmSourceMeta,
  type IngestResult,
} from '../../src/modules/nitrado/adm/serverLogIngestor';

type CursorSnapshot = {
  processedByteOffset: bigint;
  lastModifiedAt: number;
  lastKnownSize: bigint;
};

function ingestResult(newOffset: number, wasReset = false): IngestResult {
  return {
    events: [],
    newOffset,
    trailingPartial: '',
    wasReset,
  };
}

function sourceMeta(lastModifiedAt: number, fileSize: number): AdmSourceMeta {
  return {
    fileIdentity: 'adm-binding:7:DayZServer.ADM',
    fileName: 'DayZServer.ADM',
    sourceFile: 'adm-binding:7:DayZServer.ADM',
    lastModifiedAt,
    fileSize,
  };
}

function makeClient(initial: CursorSnapshot) {
  let cursor = initial;
  const upserts: unknown[] = [];

  const client: AdmPersistClient = {
    admEvent: {
      createMany: async ({ data }) => ({ count: data.length }),
    },
    admSourceCursor: {
      findUnique: async () => cursor,
      upsert: async (args) => {
        upserts.push(args);
        const update = (args as {
          update: {
            processedByteOffset: bigint;
            lastModifiedAt: number;
            lastKnownSize: bigint;
          };
        }).update;
        cursor = {
          processedByteOffset: update.processedByteOffset,
          lastModifiedAt: update.lastModifiedAt,
          lastKnownSize: update.lastKnownSize,
        };
        return {};
      },
    },
    $transaction: async (fn) => fn(client),
  };

  return {
    client,
    upserts,
    get cursor() { return cursor; },
  };
}

describe('ADM cursor generation fence', () => {
  it('rebased eine komplett gelesene same-size Datei bei neuerem mtime statt am alten Offset festzuhängen', async () => {
    const holder = makeClient({
      processedByteOffset: 100_000n,
      lastModifiedAt: 100,
      lastKnownSize: 100_000n,
    });

    await persistAdmEvents(
      holder.client,
      { guildId: 'guild', nitradoConnId: 'conn' },
      sourceMeta(101, 100_000),
      ingestResult(4_048, true),
      'new-generation-fingerprint',
    );

    expect(holder.upserts).toHaveLength(1);
    expect(holder.cursor).toEqual({
      processedByteOffset: 4_048n,
      lastModifiedAt: 101,
      lastKnownSize: 100_000n,
    });
  });

  it('aktualisiert bei einer kleinen same-size Rotation auch dann die Generation wenn der neue Offset gleich bleibt', async () => {
    const holder = makeClient({
      processedByteOffset: 4_096n,
      lastModifiedAt: 100,
      lastKnownSize: 4_096n,
    });

    await persistAdmEvents(
      holder.client,
      { guildId: 'guild', nitradoConnId: 'conn' },
      sourceMeta(101, 4_096),
      ingestResult(4_096, true),
      'replacement-fingerprint',
    );

    expect(holder.upserts).toHaveLength(1);
    expect(holder.cursor.lastModifiedAt).toBe(101);
  });

  it('laesst eine kleinere Ersatzdatei den Cursor sauber auf die neue Generation zuruecksetzen', async () => {
    const holder = makeClient({
      processedByteOffset: 100_000n,
      lastModifiedAt: 100,
      lastKnownSize: 100_000n,
    });

    await persistAdmEvents(
      holder.client,
      { guildId: 'guild', nitradoConnId: 'conn' },
      sourceMeta(100, 40_000),
      ingestResult(4_048, true),
      'truncated-generation-fingerprint',
    );

    expect(holder.upserts).toHaveLength(1);
    expect(holder.cursor.processedByteOffset).toBe(4_048n);
    expect(holder.cursor.lastKnownSize).toBe(40_000n);
  });

  it('blockiert eine kleinere Snapshot-Groesse ohne Reset-Signal auch bei gleicher mtime', async () => {
    const holder = makeClient({
      processedByteOffset: 80_000n,
      lastModifiedAt: 100,
      lastKnownSize: 100_000n,
    });

    await persistAdmEvents(
      holder.client,
      { guildId: 'guild', nitradoConnId: 'conn' },
      sourceMeta(100, 90_000),
      ingestResult(70_000),
      'same-second-stale-snapshot',
    );

    expect(holder.upserts).toHaveLength(0);
    expect(holder.cursor.processedByteOffset).toBe(80_000n);
  });

  it('blockiert weiterhin einen langsameren normalen Append-Poll mit neuerem mtime aber kleinerem Offset', async () => {
    const holder = makeClient({
      processedByteOffset: 80_000n,
      lastModifiedAt: 100,
      lastKnownSize: 100_000n,
    });

    await persistAdmEvents(
      holder.client,
      { guildId: 'guild', nitradoConnId: 'conn' },
      sourceMeta(101, 120_000),
      ingestResult(70_000),
      'append-race-fingerprint',
    );

    expect(holder.upserts).toHaveLength(0);
    expect(holder.cursor.processedByteOffset).toBe(80_000n);
  });

  it('laesst normalen Append-Fortschritt weiterhin vorwaerts laufen', async () => {
    const holder = makeClient({
      processedByteOffset: 80_000n,
      lastModifiedAt: 100,
      lastKnownSize: 100_000n,
    });

    await persistAdmEvents(
      holder.client,
      { guildId: 'guild', nitradoConnId: 'conn' },
      sourceMeta(101, 120_000),
      ingestResult(84_048),
      'append-forward-fingerprint',
    );

    expect(holder.upserts).toHaveLength(1);
    expect(holder.cursor.processedByteOffset).toBe(84_048n);
  });

  // Regression (FIX-3): eine gleichnamige, aber GROESSER gewordene Ersatzdatei
  // (der haeufigste reale Fall -- eine neue Session wird i.d.R. schnell
  // groesser als die alte) wurde bisher trotz explizitem wasReset-Signal
  // blockiert, weil shouldWriteCursor nur exakte Groessenuebereinstimmung
  // oder Schrumpfung akzeptierte. Der Cursor blieb dann dauerhaft auf der
  // alten Generation haengen. admLiveSyncCron erkennt diesen Fall inzwischen
  // inhaltsbasiert (startsWithAdmSessionHeader) und setzt wasReset=true;
  // shouldWriteCursor muss dieses Signal jetzt unabhaengig von der
  // Groessenbeziehung respektieren.
  it('rebased eine gleichnamige, groesser gewordene Ersatzdatei bei explizitem Reset-Signal', async () => {
    const holder = makeClient({
      processedByteOffset: 10_000n,
      lastModifiedAt: 100,
      lastKnownSize: 10_000n,
    });

    await persistAdmEvents(
      holder.client,
      { guildId: 'guild', nitradoConnId: 'conn' },
      sourceMeta(101, 12_500),
      ingestResult(4_048, true),
      'larger-new-generation-fingerprint',
    );

    expect(holder.upserts).toHaveLength(1);
    expect(holder.cursor).toEqual({
      processedByteOffset: 4_048n,
      lastModifiedAt: 101,
      lastKnownSize: 12_500n,
    });
  });

  it('blockiert eine groessere gleichnamige Datei weiterhin ohne explizites Reset-Signal (normales Wachstum)', async () => {
    const holder = makeClient({
      processedByteOffset: 10_000n,
      lastModifiedAt: 100,
      lastKnownSize: 10_000n,
    });

    // Kein wasReset -- das ist der normale Append-Fall (organisches Wachstum),
    // der weiterhin ausschliesslich ueber einen groesseren newOffset laufen muss.
    await persistAdmEvents(
      holder.client,
      { guildId: 'guild', nitradoConnId: 'conn' },
      sourceMeta(101, 12_500),
      ingestResult(4_048, false),
      'organic-growth-first-chunk-fingerprint',
    );

    expect(holder.upserts).toHaveLength(0);
    expect(holder.cursor.processedByteOffset).toBe(10_000n);
  });

  it('verhindert dass ein alter Generationslauf nach einem bereits erfolgten Reset wieder nach vorne schreibt', async () => {
    const holder = makeClient({
      processedByteOffset: 4_048n,
      lastModifiedAt: 101,
      lastKnownSize: 100_000n,
    });

    await persistAdmEvents(
      holder.client,
      { guildId: 'guild', nitradoConnId: 'conn' },
      sourceMeta(100, 100_000),
      ingestResult(8_096),
      'stale-generation-fingerprint',
    );

    expect(holder.upserts).toHaveLength(0);
    expect(holder.cursor).toEqual({
      processedByteOffset: 4_048n,
      lastModifiedAt: 101,
      lastKnownSize: 100_000n,
    });
  });
});
