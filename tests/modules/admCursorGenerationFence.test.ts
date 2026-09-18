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

function ingestResult(newOffset: number): IngestResult {
  return {
    events: [],
    newOffset,
    trailingPartial: '',
    wasReset: false,
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
      ingestResult(4_048),
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
      ingestResult(4_096),
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
      ingestResult(4_048),
      'truncated-generation-fingerprint',
    );

    expect(holder.upserts).toHaveLength(1);
    expect(holder.cursor.processedByteOffset).toBe(4_048n);
    expect(holder.cursor.lastKnownSize).toBe(40_000n);
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
