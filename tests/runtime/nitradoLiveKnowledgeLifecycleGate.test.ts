import fs from 'node:fs';
import path from 'node:path';

const read = (relative: string): string => fs.readFileSync(path.join(process.cwd(), relative), 'utf8');

describe('Nitrado-1S LIVE_SERVER lifecycle architecture gate', () => {
  it('centralizes generation serialization, parsing and exact mirror cleanup', () => {
    const constants = read('src/modules/ai/liveServerKnowledgeConstants.ts');
    const lifecycle = read('src/modules/ai/liveServerKnowledgeLifecycle.ts');
    const indexer = read('src/modules/ai/liveServerKnowledgeIndex.ts');

    expect(constants).toContain('export function liveServerSourceVersion');
    expect(constants).toContain('export function liveServerBindingVersionFromSourceVersion');
    expect(constants).toContain('export function liveServerConnectionIdFromSourceRef');
    expect(lifecycle).toContain('export async function deleteGeneratedLiveServerKnowledge');
    expect(lifecycle).toContain('createdBy: LIVE_SERVER_KNOWLEDGE_CREATED_BY');
    expect(lifecycle).toContain("sourceKind: 'LIVE_SERVER'");
    expect(lifecycle).toContain('liveServerSourcePrefixForConnection(nitradoConnId)');
    expect(indexer).toContain('deleteGeneratedLiveServerKnowledge(');
    expect(indexer).toContain('liveServerSourceVersion(input.binding.bindingVersion');
    expect(indexer).not.toContain('function sourceVersion(');
  });

  it('purges old mirror generation before a genuine binding rollover while preserving same-service no-op', () => {
    const source = read('src/modules/nitrado/adm/bindingState.ts');
    const sameService = source.indexOf('if (existing.currentServiceId === currentServiceId) return existing;');
    const cleanup = source.indexOf('await deleteGeneratedLiveServerKnowledge(');
    const update = source.indexOf('return client.nitradoAdmBindingState.update(', cleanup);

    expect(sameService).toBeGreaterThanOrEqual(0);
    expect(cleanup).toBeGreaterThan(sameService);
    expect(update).toBeGreaterThan(cleanup);
  });

  it('uses one provenance eligibility gate for both production and debug retrieval', () => {
    const provenance = read('src/modules/ai/knowledgeProvenance.ts');
    const retrieval = read('src/modules/ai/guildKnowledge.ts');

    expect(provenance).toContain('currentGeneratedLiveServerKnowledgeIds');
    expect(provenance).toContain('liveServerConnectionIdFromSourceRef');
    expect(provenance).toContain('liveServerBindingVersionFromSourceVersion');
    expect(provenance).toContain("conn?.status === 'ACTIVE'");
    expect(provenance).toContain('binding.currentServiceId === conn.nitradoServerId');
    expect(provenance).toContain('sourceBindingVersion === binding.bindingVersion');
    expect(provenance).toContain('freshness: \'EXPIRED\'');

    const productionStart = retrieval.indexOf('export async function findRelevantKnowledge');
    const debugStart = retrieval.indexOf('export async function debugRetrieval');
    const production = retrieval.slice(productionStart, debugStart);
    const debug = retrieval.slice(debugStart, retrieval.indexOf('export async function listKnowledge', debugStart));
    for (const block of [production, debug]) {
      expect(block).toContain('getKnowledgeProvenanceMap(guildId, scoped)');
      expect(block).toContain("freshness !== 'EXPIRED'");
    }
  });
});
