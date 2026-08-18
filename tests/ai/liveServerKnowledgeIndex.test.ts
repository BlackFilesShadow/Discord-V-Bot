const mockValidateKnowledgeScope = jest.fn();
const mockReadBlob = jest.fn();
const mockWithFreshAdmBinding = jest.fn();
const mockRefreshMirrorLeaseForCommit = jest.fn();

jest.mock('../../src/modules/ai/knowledgeScope', () => ({
  validateKnowledgeScope: (...args: unknown[]) => mockValidateKnowledgeScope(...args),
}));

jest.mock('../../src/modules/nitrado/mirror/storage', () => ({
  readBlob: (...args: unknown[]) => mockReadBlob(...args),
}));

jest.mock('../../src/modules/nitrado/adm/bindingFence', () => ({
  withFreshAdmBinding: (...args: unknown[]) => mockWithFreshAdmBinding(...args),
}));

jest.mock('../../src/modules/nitrado/mirror/mirrorLease', () => ({
  refreshMirrorLeaseForCommit: (...args: unknown[]) => mockRefreshMirrorLeaseForCommit(...args),
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

const BINDING = {
  id: 'conn-1',
  guildId: 'guild-1',
  encryptedToken: 'cipher-1',
  nitradoServerId: '123',
  bindingVersion: 3,
};

function indexInput(overrides: Partial<typeof BINDING> = {}) {
  const binding = { ...BINDING, ...overrides };
  return {
    snapshotId: 'snap-1',
    guildId: binding.guildId,
    nitradoConnId: binding.id,
    binding,
    mirrorLeaseToken: 'lease-1',
  };
}

describe('AI-14 / Nitrado-1R/1T live-server snapshot knowledge index', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockValidateKnowledgeScope.mockResolvedValue({
      ok: true,
      scope: { type: 'GAMESERVER', nitradoConnId: 'conn-1', slot: 1, alias: 'Main', alias5: 'ABCDE' },
    });
    mockWithFreshAdmBinding.mockImplementation(async (_binding: unknown, work: () => Promise<unknown>) => work());
    mockRefreshMirrorLeaseForCommit.mockResolvedValue(undefined);
    mockedPrisma.nitradoSnapshot.findFirst.mockResolvedValue({
      id: 'snap-1',
      serviceId: '123',
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

  test('requires the exact active gameserver scope, completed snapshot and original service', async () => {
    await indexNitradoSnapshotKnowledge(indexInput());
    expect(mockValidateKnowledgeScope).toHaveBeenCalledWith('guild-1', 'conn-1');
    expect(mockedPrisma.nitradoSnapshot.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: 'snap-1', guildId: 'guild-1', nitradoConnId: 'conn-1', status: { in: ['OK', 'PARTIAL'] },
      }),
      select: { id: true, serviceId: true, finishedAt: true },
    }));
  });

  test('rejects a snapshot whose persisted service differs from the captured binding', async () => {
    mockedPrisma.nitradoSnapshot.findFirst.mockResolvedValueOnce({
      id: 'snap-1', serviceId: '999', finishedAt: new Date('2026-08-17T04:00:00Z'),
    });

    await expect(indexNitradoSnapshotKnowledge(indexInput())).rejects.toThrow(/Service-Bindung/);

    expect(mockedPrisma.nitradoSnapshotFile.findMany).not.toHaveBeenCalled();
    expect(mockWithFreshAdmBinding).not.toHaveBeenCalled();
    expect(mockedPrisma.$transaction).not.toHaveBeenCalled();
  });

  test('rejects a caller that mixes binding identity with another guild or connection', async () => {
    await expect(indexNitradoSnapshotKnowledge({
      snapshotId: 'snap-1',
      guildId: 'guild-1',
      nitradoConnId: 'conn-1',
      binding: { ...BINDING, id: 'conn-2' },
      mirrorLeaseToken: 'lease-1',
    })).rejects.toThrow(/Binding stimmt nicht/);

    expect(mockValidateKnowledgeScope).not.toHaveBeenCalled();
    expect(mockedPrisma.nitradoSnapshot.findFirst).not.toHaveBeenCalled();
  });

  test('atomically replaces only system-owned live rows under binding and mirror-lease fences', async () => {
    const result = await indexNitradoSnapshotKnowledge(indexInput());
    expect(result.replacedDocuments).toBe(1);
    expect(mockWithFreshAdmBinding).toHaveBeenCalledWith(BINDING, expect.any(Function));
    expect(mockRefreshMirrorLeaseForCommit).toHaveBeenCalledWith(tx, {
      guildId: 'guild-1', nitradoConnId: 'conn-1', snapshotId: 'snap-1', leaseToken: 'lease-1',
    });
    expect(tx.guildKnowledge.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        guildId: 'guild-1',
        createdBy: LIVE_SERVER_KNOWLEDGE_CREATED_BY,
        id: { in: ['old-system', 'owner-row'] },
      }),
    }));
  });

  test('lost mirror lease blocks every local knowledge side-effect', async () => {
    mockRefreshMirrorLeaseForCommit.mockRejectedValueOnce(new Error('lost lease'));
    await expect(indexNitradoSnapshotKnowledge(indexInput())).rejects.toThrow('lost lease');
    expect(tx.guildKnowledge.deleteMany).not.toHaveBeenCalled();
    expect(tx.guildKnowledge.create).not.toHaveBeenCalled();
    expect(tx.guildKnowledgeProvenance.create).not.toHaveBeenCalled();
  });

  test('stale token/service/binding generation blocks every local knowledge side-effect', async () => {
    mockWithFreshAdmBinding.mockRejectedValueOnce(new Error('stale binding'));

    await expect(indexNitradoSnapshotKnowledge(indexInput())).rejects.toThrow('stale binding');

    expect(mockedPrisma.$transaction).not.toHaveBeenCalled();
    expect(tx.guildKnowledge.deleteMany).not.toHaveBeenCalled();
    expect(tx.guildKnowledge.create).not.toHaveBeenCalled();
    expect(tx.guildKnowledgeProvenance.create).not.toHaveBeenCalled();
  });

  test('writes every generated row with exact gameserver scope and binding-versioned LIVE_SERVER provenance', async () => {
    await indexNitradoSnapshotKnowledge(indexInput());
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
        sourceVersion: expect.stringMatching(/^b3:snap-1:/),
        observedAt: new Date('2026-08-17T04:00:00Z'),
        validUntil: new Date('2026-08-24T04:00:00Z'),
      }),
    });
  });

  test('fails closed when scope validation does not prove the requested server', async () => {
    mockValidateKnowledgeScope.mockResolvedValueOnce({ ok: false, message: 'fremder scope' });
    await expect(indexNitradoSnapshotKnowledge(indexInput()))
      .rejects.toThrow('fremder scope');
    expect(mockedPrisma.nitradoSnapshot.findFirst).not.toHaveBeenCalled();
  });

  test('clears stale generated live rows even when a new valid snapshot has zero parsable documents', async () => {
    mockedPrisma.nitradoSnapshotFile.findMany.mockResolvedValueOnce([]);
    const result = await indexNitradoSnapshotKnowledge(indexInput());
    expect(result.documents).toBe(0);
    expect(tx.guildKnowledge.deleteMany).toHaveBeenCalled();
    expect(tx.guildKnowledge.create).not.toHaveBeenCalled();
  });
});
