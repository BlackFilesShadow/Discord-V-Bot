/**
 * EmbeddingCache-Reuse-Tests.
 * Wir mocken prisma + axios und pruefen die Lookup-Reihenfolge:
 *   1) DB-Hit -> KEIN axios.post
 *   2) DB-Miss -> axios.post (Gemini) -> upsert in DB
 */

jest.mock('axios');
jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    embeddingCache: {
      findMany: jest.fn(),
      upsert: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
    },
  },
}));
jest.mock('../../src/config', () => ({
  config: {
    ai: {
      geminiApiKey: 'test-gemini-key',
      openaiApiKey: '',
    },
  },
}));

import axios from 'axios';
import prisma from '../../src/database/prisma';
import {
  generateEmbedding,
  getEmbeddingCacheStats,
  __resetEmbeddingCacheStats,
} from '../../src/modules/ai/embeddings';

const mockedAxios = axios as jest.Mocked<typeof axios>;
const mockedPrisma = prisma as unknown as {
  embeddingCache: {
    findMany: jest.Mock;
    upsert: jest.Mock;
    update: jest.Mock;
  };
};

describe('embeddings — DB-Cache-Reuse', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetEmbeddingCacheStats();
  });

  it('DB-Hit: nutzt gespeicherten Vektor und ueberspringt API-Call', async () => {
    const cached = [0.1, 0.2, 0.3];
    mockedPrisma.embeddingCache.findMany.mockResolvedValueOnce([
      {
        id: 'cache-1',
        textHash: 'whatever',
        model: 'gemini:text-embedding-004',
        vector: JSON.stringify(cached),
        dim: 3,
        useCount: 1,
        lastUsedAt: new Date(),
      },
    ]);

    const result = await generateEmbedding('Hallo Welt');
    expect(result).toEqual({ vector: cached, model: 'gemini:text-embedding-004' });
    expect(mockedAxios.post).not.toHaveBeenCalled();
    expect(mockedPrisma.embeddingCache.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'cache-1' },
        data: expect.objectContaining({ useCount: { increment: 1 } }),
      }),
    );
    expect(getEmbeddingCacheStats()).toEqual({ hits: 1, misses: 0 });
  });

  it('DB-Miss: ruft API auf und persistiert Ergebnis', async () => {
    mockedPrisma.embeddingCache.findMany.mockResolvedValueOnce([]);
    const apiVec = [0.5, 0.6, 0.7, 0.8];
    mockedAxios.post.mockResolvedValueOnce({
      data: { embedding: { values: apiVec } },
    });

    const result = await generateEmbedding('Neue Frage');
    expect(result).toEqual({ vector: apiVec, model: 'gemini:text-embedding-004' });
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    expect(mockedPrisma.embeddingCache.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          model: 'gemini:text-embedding-004',
          dim: 4,
        }),
      }),
    );
    expect(getEmbeddingCacheStats()).toEqual({ hits: 0, misses: 1 });
  });

  it('normalisierter Hash: Whitespace/Casing-Varianten treffen denselben Cache', async () => {
    const cached = [0.9, 0.8];
    mockedPrisma.embeddingCache.findMany.mockResolvedValue([
      {
        id: 'cache-norm',
        textHash: 'h',
        model: 'gemini:text-embedding-004',
        vector: JSON.stringify(cached),
        dim: 2,
        useCount: 1,
        lastUsedAt: new Date(),
      },
    ]);

    await generateEmbedding('Hallo Welt');
    await generateEmbedding('  HALLO   welt  ');
    await generateEmbedding('hallo welt');

    // alle 3 Calls landen im DB-Lookup mit demselben Hash
    const calls = mockedPrisma.embeddingCache.findMany.mock.calls;
    expect(calls).toHaveLength(3);
    const hashes = calls.map((c) => (c[0] as { where: { textHash: string } }).where.textHash);
    expect(new Set(hashes).size).toBe(1);
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('leere Eingabe: kein DB-Lookup, kein API-Call', async () => {
    const result = await generateEmbedding('   ');
    expect(result).toBeNull();
    expect(mockedPrisma.embeddingCache.findMany).not.toHaveBeenCalled();
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('korrupte Cache-Row (dim mismatch): faellt auf API zurueck', async () => {
    mockedPrisma.embeddingCache.findMany.mockResolvedValueOnce([
      {
        id: 'corrupt',
        textHash: 'h',
        model: 'gemini:text-embedding-004',
        vector: JSON.stringify([0.1, 0.2]),
        dim: 99, // mismatched
        useCount: 1,
        lastUsedAt: new Date(),
      },
    ]);
    mockedAxios.post.mockResolvedValueOnce({
      data: { embedding: { values: [1, 2, 3] } },
    });

    const result = await generateEmbedding('test');
    expect(result?.vector).toEqual([1, 2, 3]);
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
  });
});
