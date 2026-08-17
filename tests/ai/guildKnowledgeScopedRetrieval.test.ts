const mockGetQueryEmbedding = jest.fn();

jest.mock('../../src/modules/ai/embeddings', () => ({
  cosineSimilarity: jest.fn(() => 0),
  embedKnowledgeSnippet: jest.fn(async () => true),
  getQueryEmbedding: (...args: unknown[]) => mockGetQueryEmbedding(...args),
}));

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    guildKnowledge: { findMany: jest.fn() },
    guildKnowledgeScope: { findMany: jest.fn() },
    guildKnowledgeProvenance: { findMany: jest.fn() },
    nitradoConnection: { findMany: jest.fn(), findFirst: jest.fn() },
  },
}));

import prisma from '../../src/database/prisma';
import { findRelevantKnowledge } from '../../src/modules/ai/guildKnowledge';

const mockedPrisma = prisma as unknown as {
  guildKnowledge: { findMany: jest.Mock };
  guildKnowledgeScope: { findMany: jest.Mock };
  guildKnowledgeProvenance: { findMany: jest.Mock };
};

function knowledgeRow(id: string, label: string, content: string) {
  return {
    id,
    label,
    content,
    embedding: null,
    embeddingModel: null,
    createdAt: new Date('2026-08-16T20:00:00Z'),
  };
}

describe('AI-10/11/13 scoped + provenance-aware hybrid retrieval', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetQueryEmbedding.mockResolvedValue(null);
    mockedPrisma.guildKnowledgeProvenance.findMany.mockResolvedValue([]);
    mockedPrisma.guildKnowledge.findMany.mockResolvedValue([
      knowledgeRow('global', 'Allgemein', 'restart apple global'),
      knowledgeRow('server-1', 'Restart', 'apple restart fuer slot eins'),
      knowledgeRow('server-2', 'apple restart apple', 'apple apple apple fremder server'),
    ]);
    mockedPrisma.guildKnowledgeScope.findMany.mockResolvedValue([
      { knowledgeId: 'server-1', nitradoConnId: 'conn-1' },
      { knowledgeId: 'server-2', nitradoConnId: 'conn-2' },
    ]);
  });

  it('rankt bei Live-Gameserver-Scope ausschliesslich exakt diesen Gameserver', async () => {
    const result = await findRelevantKnowledge('guild-1', 'apple restart', 3, 'conn-1');
    expect(result.map(row => row.id)).toEqual(['server-1']);
    expect(result.map(row => row.id)).not.toContain('global');
    expect(result.map(row => row.id)).not.toContain('server-2');
  });

  it('liefert bei global-only niemals servergebundene Snippets', async () => {
    const result = await findRelevantKnowledge('guild-1', 'apple restart', 3, null);
    expect(result.map(row => row.id)).toEqual(['global']);
  });

  it('fragt Scope- und Provenance-Metadaten fuer exakt dieselbe Guild ab', async () => {
    await findRelevantKnowledge('guild-xyz', 'apple restart', 3, 'conn-1');
    expect(mockedPrisma.guildKnowledgeScope.findMany).toHaveBeenCalledWith({
      where: { guildId: 'guild-xyz' },
      select: { knowledgeId: true, nitradoConnId: true },
    });
    expect(mockedPrisma.guildKnowledgeProvenance.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { guildId: 'guild-xyz' },
    }));
  });

  it('schliesst EXPIRED Quellen vor dem Ranking aus, selbst wenn sie den staerksten Keyword-Treffer haben', async () => {
    mockedPrisma.guildKnowledgeScope.findMany.mockResolvedValue([]);
    mockedPrisma.guildKnowledge.findMany.mockResolvedValue([
      knowledgeRow('valid', 'Restart', 'restart apple'),
      knowledgeRow('expired', 'restart apple restart', 'restart apple apple apple'),
    ]);
    mockedPrisma.guildKnowledgeProvenance.findMany.mockResolvedValue([
      {
        knowledgeId: 'expired',
        sourceKind: 'OFFICIAL_DOC',
        trustLevel: 'AUTHORITATIVE',
        sourceRef: 'official:expired',
        sourceVersion: 'old',
        observedAt: new Date('2026-08-01T00:00:00Z'),
        validUntil: new Date('2026-08-16T22:00:00Z'),
      },
    ]);

    const result = await findRelevantKnowledge('guild-1', 'restart apple', 3, null);
    expect(result.map(row => row.id)).toEqual(['valid']);
  });

  it('bevorzugt bei gleicher fachlicher Relevanz die hoeher vertraute, gleich frische Quelle', async () => {
    mockedPrisma.guildKnowledgeScope.findMany.mockResolvedValue([]);
    mockedPrisma.guildKnowledge.findMany.mockResolvedValue([
      knowledgeRow('low', 'Restart', 'restart apple'),
      knowledgeRow('high', 'Restart', 'restart apple'),
    ]);
    const observedAt = new Date(Date.now() - 60 * 60_000);
    mockedPrisma.guildKnowledgeProvenance.findMany.mockResolvedValue([
      {
        knowledgeId: 'low', sourceKind: 'IMPORTED', trustLevel: 'UNVERIFIED', sourceRef: null,
        sourceVersion: null, observedAt, validUntil: null,
      },
      {
        knowledgeId: 'high', sourceKind: 'OFFICIAL_DOC', trustLevel: 'AUTHORITATIVE', sourceRef: 'official:doc',
        sourceVersion: 'v1', observedAt, validUntil: null,
      },
    ]);

    const result = await findRelevantKnowledge('guild-1', 'restart apple', 2, null);
    expect(result.map(row => row.id)).toEqual(['high', 'low']);
    expect(result[0].provenance?.trustLevel).toBe('AUTHORITATIVE');
  });

  it('wertet korrupte persistierte AUTHORITATIVE-Metadaten ohne Source-Ref konservativ als Legacy/CURATED', async () => {
    mockedPrisma.guildKnowledgeScope.findMany.mockResolvedValue([]);
    mockedPrisma.guildKnowledge.findMany.mockResolvedValue([knowledgeRow('corrupt', 'Restart', 'restart apple')]);
    mockedPrisma.guildKnowledgeProvenance.findMany.mockResolvedValue([
      {
        knowledgeId: 'corrupt', sourceKind: 'OFFICIAL_DOC', trustLevel: 'AUTHORITATIVE', sourceRef: null,
        sourceVersion: 'v1', observedAt: new Date(), validUntil: null,
      },
    ]);

    const result = await findRelevantKnowledge('guild-1', 'restart apple', 1, null);
    expect(result[0].provenance?.trustLevel).toBe('CURATED');
    expect(result[0].provenance?.legacyDefault).toBe(true);
  });
});
