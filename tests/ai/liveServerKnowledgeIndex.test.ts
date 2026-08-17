const mockValidateKnowledgeScope = jest.fn();
const mockReadBlob = jest.fn();

jest.mock('../../src/modules/ai/knowledgeScope', () => ({
  validateKnowledgeScope: (...args: unknown[]) => mockValidateKnowledgeScope(...args),
}));

jest.mock('../../src/modules/nitrado/mirror/storage', () => ({
  readBlob: (...args: unknown[]) => mockReadBlob(...args),
}));

const tx = {
  guildKnowledgeScope: { findMany: jest.fn(), create: jest.fn(), deleteMany: jest.fn() },
  guildKnowledge: { findMany: jest.fn(), create: jest.fn(), deleteMany: jest.fn() },
  guildKnowledgeProvenance: { findMany: jest.fn(), create: jest.fn(), deleteMany: jest.fn() },
};

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    nitradoSnapshot: { findFirst: jest.fn() },
    nitradoSnapshotFile: { findMany: jest.fn() },
    $transaction: jest.fn(async (fn: (arg: typeof tx) => unknown) => fn(tx)),
  },
}));

import prisma from '../../src/database/prisma';
import { indexNitradoSnapshotKnowledge } from '../../src/modules/ai/liveServerKnowledgeIndex';
import { LIVE_SERVER_KNOWLEDGE_CREATED_BY } from '../../src/modules/ai/liveServerKnowledgeConstants';

const mockedPrisma = prisma as unknown as {
  nitradoSnapshot: { findFirst: jest.Mock };
  nitradoSnapshotFile: { findMany: jest.Mock };
  $transaction: jest.Mock;
};

describe('AI-14 live-server snapshot knowledge index', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockValidateKnowledgeScope.mockResolvedValue({
      ok: true,
      scope: { type: 'GAMESERVER', nitradoConnId: 'conn-1', slot: 1, alias: 'Main', alias5: 'ABCDE' },
    });
    mockedPrisma.nitradoSnapshot.findFirst.mockResolvedValue({
      id: 'snap-1',
      finishedAt: new Date('2026-08-17T04:00:00Z'),
    });
    mockedPrisma.nitradoSnapshotFile.findMany.mockResolvedValue([
      {
        path: '/serverDZ.cfg', name: 'serverDZ.cfg', sizeBytes: 120n, sha256: 'a'.repeat(64),
        contentText: 'maxPlayers = 50; template = "dayzOffline.chernarusplus";', storedPath: null,
      },
      {
        path: '/mpmissions/dayzOffline.chernarusplus/db/types.xml', name: 'types.xml', sizeBytes: 200n, sha256: 'b'.repeat(64),
        contentText: '<types><type name="M4A1"><nominal>5</nominal><min>2</min></type></types>', storedPath: null,
      },
    ]);
    tx.guildKnowledgeScope.findMany.mockResolvedValue([
      { knowledgeId: 'old-system' },
      { knowledgeId: 'owner-row' },
    ]);
    tx.guildKnowledge.findMany.mockResolvedValue([{ id: 'old-system' }]);
    tx.guildKnowledgeProvenance.findMany.mockResolvedValue([{ knowledgeId: 'old-system' }]);
    tx.guildKnowledge.create
      .mockResolvedValueOnce({ id: 'new-1' })
      .mockResolvedValueOnce({ id: 'new-2' });
  });

  test('requires the exact active gameserver scope and completed snapshot', async () => {
    await indexNitradoSnapshotKnowledge({ snapshotId: 'snap-1', guildId: 'guild-1', nitradoConnId: 'conn-1' });
    expect(mockValidateKnowledgeScope).toHaveBeenCalledWith('guild-1', 'conn-1');
    expect(mockedPrisma.nitradoSnapshot.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: 'snap-1', guildId: 'guild-1', nitradoConnId: 'conn-1', status: { in: ['OK', 'PARTIAL'] },
      }),
    }));
  });

  test('atomically replaces only system-owned live rows for the same connection', async () => {
    const result = await indexNitradoSnapshotKnowledge({ snapshotId: 'snap-1', guildId: 'guild-1', nitradoConnId: 'conn-1' });
    expect(result.replacedDocuments).toBe(1);
    expect(tx.guildKnowledge.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        guildId: 'guild-1',
        createdBy: LIVE_SERVER_KNOWLEDGE_CREATED_BY,
        id: { in: ['old-system', 'owner-row'] },
      }),
    }));
    expect(tx.guildKnowledge.deleteMany).toHaveBeenCalledWith({
      where: { guildId: 'guild-1', id: { in: ['old-system'] }, createdBy: LIVE_SERVER_KNOWLEDGE_CREATED_BY },
    });
  });

  test('writes every generated row with exact gameserver scope and LIVE_SERVER provenance', async () => {
    await indexNitradoSnapshotKnowledge({ snapshotId: 'snap-1', guildId: 'guild-1', nitradoConnId: 'conn-1' });
    expect(tx.guildKnowledge.create).toHaveBeenCalled();
    for (const call of tx.guildKnowledge.create.mock.calls) {
      expect(call[0].data.createdBy).toBe(LIVE_SERVER_KNOWLEDGE_CREATED_BY);
      expect(call[0].data.guildId).toBe('guild-1');
    }
    expect(tx.guildKnowledgeScope.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ guildId: 'guild-1', nitradoConnId: 'conn-1' }),
    });
    expect(tx.guildKnowledgeProvenance.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        guildId: 'guild-1',
        sourceKind: 'LIVE_SERVER',
        trustLevel: 'VERIFIED',
        sourceRef: expect.stringMatching(/^nitrado-mirror:\/\/conn-1\//),
        observedAt: new Date('2026-08-17T04:00:00Z'),
        validUntil: new Date('2026-08-24T04:00:00Z'),
      }),
    });
  });

  test('fails closed when scope validation does not prove the requested server', async () => {
    mockValidateKnowledgeScope.mockResolvedValueOnce({ ok: false, message: 'fremder scope' });
    await expect(indexNitradoSnapshotKnowledge({
      snapshotId: 'snap-1', guildId: 'guild-1', nitradoConnId: 'foreign',
    })).rejects.toThrow('fremder scope');
    expect(mockedPrisma.nitradoSnapshot.findFirst).not.toHaveBeenCalled();
  });

  test('clears stale generated live rows even when a new valid snapshot has zero parsable documents', async () => {
    mockedPrisma.nitradoSnapshotFile.findMany.mockResolvedValueOnce([]);
    const result = await indexNitradoSnapshotKnowledge({ snapshotId: 'snap-1', guildId: 'guild-1', nitradoConnId: 'conn-1' });
    expect(result.documents).toBe(0);
    expect(tx.guildKnowledge.deleteMany).toHaveBeenCalled();
    expect(tx.guildKnowledge.create).not.toHaveBeenCalled();
  });
});
