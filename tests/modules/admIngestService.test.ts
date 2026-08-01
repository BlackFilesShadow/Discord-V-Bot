process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

/**
 * Phase 3, Schritt 3: admIngestService laedt den byte-genauen Cursor und
 * persistiert AdmEvents idempotent (skipDuplicates).
 */
const seenKeys = new Set<string>();
let cursorRow: { processedByteOffset: bigint } | null = null;

const prismaMock = {
  admSourceCursor: {
    findUnique: jest.fn(async () => cursorRow),
    upsert: jest.fn(async () => ({})),
  },
  admEvent: {
    createMany: jest.fn(async ({ data, skipDuplicates }: { data: Array<{ eventKey: string }>; skipDuplicates?: boolean }) => {
      let count = 0;
      for (const r of data) { if (skipDuplicates && seenKeys.has(r.eventKey)) continue; seenKeys.add(r.eventKey); count++; }
      return { count };
    }),
  },
  $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prismaMock),
};
jest.mock('../../src/database/prisma', () => ({ __esModule: true, default: prismaMock }));

import { ingestAdmFile } from '../../src/modules/nitrado/adm/admIngestService';

const content =
  'AdminLog started on 2026-07-01 at 18:00:00\n' +
  '18:00:12 | Player "Alpha"(id=1) is connected\n' +
  '18:20:00 | Player "Alpha"(id=1) has been disconnected\n';

beforeEach(() => { jest.clearAllMocks(); seenKeys.clear(); cursorRow = null; });

describe('admIngestService', () => {
  it('startet ohne Cursor bei Offset 0 und speichert Events', async () => {
    const r = await ingestAdmFile({ guildId: 'g1', nitradoConnId: 'c1' }, { fileName: 'f.ADM', modifiedAt: 1, size: content.length, content });
    expect(r.inserted).toBe(2); // connect + disconnect
    expect(prismaMock.admSourceCursor.upsert).toHaveBeenCalledTimes(1);
  });

  it('zweiter Lauf mit Cursor am Dateiende liefert keine neuen Events', async () => {
    await ingestAdmFile({ guildId: 'g1', nitradoConnId: 'c1' }, { fileName: 'f.ADM', modifiedAt: 1, size: content.length, content });
    cursorRow = { processedByteOffset: BigInt(Buffer.byteLength(content, 'utf8')) };
    const r = await ingestAdmFile({ guildId: 'g1', nitradoConnId: 'c1' }, { fileName: 'f.ADM', modifiedAt: 2, size: content.length, content });
    expect(r.inserted).toBe(0);
  });
});
