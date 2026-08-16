const mockGetQueryEmbedding = jest.fn();

jest.mock('../../src/modules/ai/embeddings', () => ({
  cosineSimilarity: jest.fn(() => 0),
  embedKnowledgeSnippet: jest.fn(async () => true),
  getQueryEmbedding: (...args: unknown[]) => mockGetQueryEmbedding(...args),
}));

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    guildKnowledge: {
      findMany: jest.fn(),
    },
    guildKnowledgeScope: {
      findMany: jest.fn(),
    },
    nitradoConnection: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
    },
  },
}));

import prisma from '../../src/database/prisma';
import { findRelevantKnowledge } from '../../src/modules/ai/guildKnowledge';

const mockedPrisma = prisma as unknown as {
  guildKnowledge: { findMany: jest.Mock };
  guildKnowledgeScope: { findMany: jest.Mock };
};

function knowledgeRow(id: string, label: string, content: string) {
  return {
    id,
    label,
    content,
    embedding: null,
    embeddingModel: null,
    createdAt: new Date('2026-08-17T00:00:00Z'),
  };
}

describe('AI-10 scoped hybrid retrieval', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetQueryEmbedding.mockResolvedValue(null);
    mockedPrisma.guildKnowledge.findMany.mockResolvedValue([
      knowledgeRow('global', 'Allgemein', 'restart apple global'),
      knowledgeRow('server-1', 'Restart', 'apple restart fuer slot eins'),
      // Absichtlich der staerkste Keyword-/Label-Treffer. Wenn Scope erst NACH
      // dem Ranking greifen wuerde, koennte dieser fremde Server die Rangfolge
      // bzw. Normalisierung beeinflussen.
      knowledgeRow('server-2', 'apple restart apple', 'apple apple apple fremder server'),
    ]);
    mockedPrisma.guildKnowledgeScope.findMany.mockResolvedValue([
      { knowledgeId: 'server-1', nitradoConnId: 'conn-1' },
      { knowledgeId: 'server-2', nitradoConnId: 'conn-2' },
    ]);
  });

  it('rankt bei Gameserver-Scope nur guild-global + exakt denselben Gameserver', async () => {
    const result = await findRelevantKnowledge('guild-1', 'apple restart', 3, 'conn-1');
    expect(result.map(row => row.id)).toEqual(expect.arrayContaining(['global', 'server-1']));
    expect(result.map(row => row.id)).not.toContain('server-2');
  });

  it('liefert bei global-only niemals servergebundene Snippets', async () => {
    const result = await findRelevantKnowledge('guild-1', 'apple restart', 3, null);
    expect(result.map(row => row.id)).toEqual(['global']);
  });

  it('fragt Scope-Metadaten fuer exakt dieselbe Guild ab', async () => {
    await findRelevantKnowledge('guild-xyz', 'apple restart', 3, 'conn-1');
    expect(mockedPrisma.guildKnowledgeScope.findMany).toHaveBeenCalledWith({
      where: { guildId: 'guild-xyz' },
      select: { knowledgeId: true, nitradoConnId: true },
    });
  });
});
