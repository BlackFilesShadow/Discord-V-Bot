process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

/**
 * Regressionsschutz: getSettings/listFiles/findFiles/getFile in
 * mirror/queryApi.ts sind die einzige Lese-Schnittstelle, ueber die laut
 * eigenem Header-Kommentar kuenftig auch "Bot, Dashboard und die KI/RAG-
 * Schicht" Snapshot-Daten abfragen sollen. Vor diesem Fix nahmen sie nur
 * snapshotId entgegen - Guild-Scoping war reine Aufrufer-Disziplin (aktuell
 * korrekt in devNitradoMirror.ts, aber eine latente Falle fuer jeden
 * kuenftigen Aufrufer, der den Guild-Check vergisst). Diese Tests pinnen,
 * dass guildId jetzt zwingend Teil der DB-Query selbst ist.
 */
const mockFindFirstSnapshot = jest.fn();
const mockFindManySnapshotFile = jest.fn();
const mockFindFirstSnapshotFile = jest.fn();

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    nitradoSnapshot: {
      findFirst: (...args: unknown[]) => mockFindFirstSnapshot(...args),
    },
    nitradoSnapshotFile: {
      findMany: (...args: unknown[]) => mockFindManySnapshotFile(...args),
      findFirst: (...args: unknown[]) => mockFindFirstSnapshotFile(...args),
    },
  },
}));

import { getSettings, listFiles, findFiles, getFile } from '../../src/modules/nitrado/mirror/queryApi';

const SNAPSHOT_ID = 'snap_1';
const GUILD_ID = 'guild_1';

beforeEach(() => {
  jest.clearAllMocks();
  mockFindFirstSnapshot.mockResolvedValue(null);
  mockFindManySnapshotFile.mockResolvedValue([]);
  mockFindFirstSnapshotFile.mockResolvedValue(null);
});

describe('mirror/queryApi guild scoping', () => {
  it('getSettings filtert per guildId direkt in der Query, nicht nur per id', async () => {
    await getSettings(SNAPSHOT_ID, GUILD_ID);
    expect(mockFindFirstSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: SNAPSHOT_ID, guildId: GUILD_ID },
    }));
  });

  it('listFiles filtert per guildId ueber die snapshot-Relation', async () => {
    await listFiles(SNAPSHOT_ID, GUILD_ID, '/');
    expect(mockFindManySnapshotFile).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ snapshotId: SNAPSHOT_ID, snapshot: { guildId: GUILD_ID } }),
    }));
  });

  it('findFiles filtert per guildId ueber die snapshot-Relation', async () => {
    await findFiles(SNAPSHOT_ID, GUILD_ID, 'types');
    expect(mockFindManySnapshotFile).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ snapshotId: SNAPSHOT_ID, snapshot: { guildId: GUILD_ID } }),
    }));
  });

  it('getFile filtert per guildId ueber die snapshot-Relation', async () => {
    await getFile(SNAPSHOT_ID, GUILD_ID, '/serverDZ.cfg');
    expect(mockFindFirstSnapshotFile).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ snapshotId: SNAPSHOT_ID, path: '/serverDZ.cfg', snapshot: { guildId: GUILD_ID } }),
    }));
  });
});
