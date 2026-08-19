const provenanceFindMany = jest.fn();
const connectionFindMany = jest.fn();
const bindingFindMany = jest.fn();

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    guildKnowledgeProvenance: { findMany: (...args: unknown[]) => provenanceFindMany(...args) },
    nitradoConnection: { findMany: (...args: unknown[]) => connectionFindMany(...args) },
    nitradoAdmBindingState: { findMany: (...args: unknown[]) => bindingFindMany(...args) },
  },
}));

import { getKnowledgeProvenanceMap } from '../../src/modules/ai/knowledgeProvenance';

const NOW = new Date('2026-08-19T04:00:00.000Z');
const CONN = 'c123456789012345678901234';
const KNOWLEDGE = { id: 'knowledge-1', createdAt: new Date('2026-08-19T03:00:00.000Z') };

function liveRow(sourceVersion: string | null) {
  return {
    knowledgeId: KNOWLEDGE.id,
    sourceKind: 'LIVE_SERVER',
    trustLevel: 'VERIFIED',
    sourceRef: `nitrado-mirror://${encodeURIComponent(CONN)}/types.xml`,
    sourceVersion,
    observedAt: new Date('2026-08-19T03:30:00.000Z'),
    validUntil: new Date('2026-08-26T03:30:00.000Z'),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  provenanceFindMany.mockResolvedValue([liveRow('b2:snapshot:sha')]);
  connectionFindMany.mockResolvedValue([{ id: CONN, nitradoServerId: '12345' }]);
  bindingFindMany.mockResolvedValue([{ nitradoConnId: CONN, bindingVersion: 2, currentServiceId: '12345' }]);
});

describe('Nitrado-1S LIVE_SERVER binding lifecycle', () => {
  it('keeps only the current ACTIVE service binding generation eligible', async () => {
    const map = await getKnowledgeProvenanceMap('guild-1', [KNOWLEDGE], NOW);
    const meta = map.get(KNOWLEDGE.id)!;

    expect(meta.sourceKind).toBe('LIVE_SERVER');
    expect(meta.freshness).not.toBe('EXPIRED');
    expect(meta.qualityFactor).toBeGreaterThan(0);
    expect(connectionFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ guildId: 'guild-1', id: { in: [CONN] }, status: 'ACTIVE' }),
    }));
    expect(bindingFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { guildId: 'guild-1', nitradoConnId: { in: [CONN] } },
    }));
  });

  it('expires an older binding generation immediately after a rebind', async () => {
    provenanceFindMany.mockResolvedValue([liveRow('b1:snapshot:sha')]);

    const map = await getKnowledgeProvenanceMap('guild-1', [KNOWLEDGE], NOW);
    expect(map.get(KNOWLEDGE.id)).toEqual(expect.objectContaining({
      freshness: 'EXPIRED',
      freshnessScore: 0,
      qualityFactor: 0,
    }));
  });

  it('fails closed for legacy unversioned LIVE_SERVER provenance', async () => {
    provenanceFindMany.mockResolvedValue([liveRow('snapshot:sha')]);

    const map = await getKnowledgeProvenanceMap('guild-1', [KNOWLEDGE], NOW);
    expect(map.get(KNOWLEDGE.id)?.freshness).toBe('EXPIRED');
  });

  it('fails closed when the current binding row is missing', async () => {
    bindingFindMany.mockResolvedValue([]);

    const map = await getKnowledgeProvenanceMap('guild-1', [KNOWLEDGE], NOW);
    expect(map.get(KNOWLEDGE.id)?.freshness).toBe('EXPIRED');
  });

  it('fails closed when connection service and ADM binding disagree', async () => {
    bindingFindMany.mockResolvedValue([{ nitradoConnId: CONN, bindingVersion: 2, currentServiceId: '99999' }]);

    const map = await getKnowledgeProvenanceMap('guild-1', [KNOWLEDGE], NOW);
    expect(map.get(KNOWLEDGE.id)?.freshness).toBe('EXPIRED');
  });

  it('does not require Nitrado binding reads for non-live provenance', async () => {
    provenanceFindMany.mockResolvedValue([{
      knowledgeId: KNOWLEDGE.id,
      sourceKind: 'OWNER_CURATED',
      trustLevel: 'CURATED',
      sourceRef: null,
      sourceVersion: null,
      observedAt: new Date('2026-08-19T03:30:00.000Z'),
      validUntil: null,
    }]);

    const map = await getKnowledgeProvenanceMap('guild-1', [KNOWLEDGE], NOW);
    expect(map.get(KNOWLEDGE.id)?.freshness).not.toBe('EXPIRED');
    expect(connectionFindMany).not.toHaveBeenCalled();
    expect(bindingFindMany).not.toHaveBeenCalled();
  });
});
