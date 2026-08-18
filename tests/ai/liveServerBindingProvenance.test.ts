const provenanceFindMany = jest.fn();
const knowledgeFindMany = jest.fn();
const connectionFindMany = jest.fn();
const bindingFindMany = jest.fn();

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    guildKnowledgeProvenance: { findMany: (...args: unknown[]) => provenanceFindMany(...args) },
    guildKnowledge: { findMany: (...args: unknown[]) => knowledgeFindMany(...args) },
    nitradoConnection: { findMany: (...args: unknown[]) => connectionFindMany(...args) },
    nitradoAdmBindingState: { findMany: (...args: unknown[]) => bindingFindMany(...args) },
  },
}));

import { getKnowledgeProvenanceMap } from '../../src/modules/ai/knowledgeProvenance';

const NOW = new Date('2026-08-18T12:00:00.000Z');
const OBSERVED = new Date('2026-08-18T11:00:00.000Z');
const VALID_UNTIL = new Date('2026-08-25T11:00:00.000Z');
const GUILD = 'guild-1';
const CONN = 'conn-1';

function liveRow(id: string, sourceVersion: string | null) {
  return {
    knowledgeId: id,
    sourceKind: 'LIVE_SERVER',
    trustLevel: 'VERIFIED',
    sourceRef: `nitrado-mirror://${CONN}/types.xml`,
    sourceVersion,
    observedAt: OBSERVED,
    validUntil: VALID_UNTIL,
  };
}

function arrange(args: {
  sourceVersion?: string | null;
  systemOwned?: boolean;
  status?: string;
  serviceId?: string | null;
  binding?: { bindingVersion: number; currentServiceId: string | null } | null;
} = {}) {
  provenanceFindMany.mockResolvedValue([
    liveRow('live-1', args.sourceVersion === undefined ? 'b3:snap-1:aaaaaaaa' : args.sourceVersion),
  ]);
  knowledgeFindMany.mockImplementation(async () => args.systemOwned === false ? [] : [{ id: 'live-1' }]);
  connectionFindMany.mockResolvedValue([{
    id: CONN,
    status: args.status ?? 'ACTIVE',
    nitradoServerId: args.serviceId === undefined ? '123' : args.serviceId,
  }]);
  const binding = args.binding === undefined
    ? { bindingVersion: 3, currentServiceId: '123' }
    : args.binding;
  bindingFindMany.mockResolvedValue(binding ? [{ nitradoConnId: CONN, ...binding }] : []);
}

beforeEach(() => {
  jest.clearAllMocks();
  arrange();
});

describe('Nitrado-1S LIVE_SERVER binding-generation provenance gate', () => {
  it('keeps current generated LIVE_SERVER generation eligible', async () => {
    const map = await getKnowledgeProvenanceMap(GUILD, [{ id: 'live-1', createdAt: OBSERVED }], NOW);
    expect(map.get('live-1')?.freshness).toBe('FRESH');
    expect(map.get('live-1')?.qualityFactor).toBeGreaterThan(0);
  });

  it.each([
    ['old generation', { sourceVersion: 'b2:snap-1:aaaaaaaa' }],
    ['legacy unversioned', { sourceVersion: 'snap-1:aaaaaaaa' }],
    ['missing binding', { binding: null }],
    ['inactive connection', { status: 'EXPIRED' }],
    ['null service', { serviceId: null }],
    ['service mismatch', { binding: { bindingVersion: 3, currentServiceId: '999' } }],
  ])('expires %s before ranking', async (_label, overrides) => {
    arrange(overrides as Parameters<typeof arrange>[0]);
    const map = await getKnowledgeProvenanceMap(GUILD, [{ id: 'live-1', createdAt: OBSERVED }], NOW);
    expect(map.get('live-1')).toEqual(expect.objectContaining({
      sourceKind: 'LIVE_SERVER',
      freshness: 'EXPIRED',
      freshnessScore: 0,
      qualityFactor: 0,
    }));
  });

  it('does not apply binding generation policy to owner-curated knowledge', async () => {
    arrange({ sourceVersion: null, systemOwned: false, binding: null, status: 'EXPIRED' });
    const map = await getKnowledgeProvenanceMap(GUILD, [{ id: 'live-1', createdAt: OBSERVED }], NOW);
    expect(map.get('live-1')?.freshness).toBe('FRESH');
    expect(map.get('live-1')?.qualityFactor).toBeGreaterThan(0);
  });
});
