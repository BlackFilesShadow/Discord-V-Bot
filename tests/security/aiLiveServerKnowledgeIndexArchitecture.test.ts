import fs from 'fs';
import path from 'path';

const read = (relative: string): string => fs.readFileSync(path.join(process.cwd(), relative), 'utf8');

describe('AI-14 / Nitrado-1T snapshot -> normalized LIVE_SERVER knowledge architecture', () => {
  test('snapshot completion invokes canonical indexer only after lease finalization and releases singleflight afterwards', () => {
    const source = read('src/modules/nitrado/mirror/snapshotService.ts');
    expect(source).toContain("await import('../../ai/liveServerKnowledgeIndex.js')");
    expect(source).toContain('mirrorLeaseToken: leaseToken');
    expect(source).toContain("if (status === 'OK' || status === 'PARTIAL')");
    expect(source).toContain('finalizeMirrorSnapshotLease({');
    expect(source).toContain('releaseMirrorSnapshotLease({');
    expect(source).toContain("logger.warn('[AI-14] Live-Server-Knowledge konnte nicht aktualisiert werden'");
  });

  test('indexer validates guild+gameserver+snapshot and writes under binding plus mirror-lease fences', () => {
    const source = read('src/modules/ai/liveServerKnowledgeIndex.ts');
    expect(source).toContain('validateKnowledgeScope(input.guildId, input.nitradoConnId)');
    expect(source).toContain("status: { in: ['OK', 'PARTIAL'] }");
    expect(source).toContain('nitradoConnId: input.nitradoConnId');
    expect(source).toContain('snapshot.serviceId !== input.binding.nitradoServerId');
    expect(source).toContain('withFreshAdmBinding(input.binding');
    expect(source).toContain('refreshMirrorLeaseForCommit(');
    expect(source).toContain('leaseToken: input.mirrorLeaseToken');
    expect(source).toContain("sourceKind: 'LIVE_SERVER'");
    expect(source).toContain("trustLevel: 'VERIFIED'");
    expect(source).toContain('validUntil');
    expect(source).toContain('prisma.$transaction');
    expect(source).toContain('createdBy: LIVE_SERVER_KNOWLEDGE_CREATED_BY');
  });

  test('only allowlisted DayZ configuration files enter the parser and secrets remain redacted', () => {
    const source = read('src/modules/ai/liveServerKnowledgeParser.ts');
    for (const name of ['serverdz.cfg', 'cfggameplay.json', 'types.xml', 'events.xml', 'globals.xml', 'cfgweather.xml', 'cfgspawnabletypes.xml']) {
      expect(source).toContain(`'${name}'`);
    }
    expect(source).toContain('isSensitiveKey');
    expect(source).toContain('redactText');
    expect(source).toContain('redactValue');
    expect(source).toContain('Mehrdeutig ohne eindeutige aktive Mission => fail-closed');
  });

  test('system live knowledge cannot consume or mutate the owner-curated knowledge inventory', () => {
    const source = read('src/modules/ai/guildKnowledge.ts');
    expect(source).toContain("createdBy: { not: LIVE_SERVER_KNOWLEDGE_CREATED_BY }");
    expect(source).toContain('isLiveServerSystemKnowledgeCreatedBy(row.createdBy)');
    expect(source).toContain('Live-Server-Knowledge wird automatisch durch Nitrado-Snapshots verwaltet.');
    expect(source).toContain('MAX_RETRIEVAL_CANDIDATES = 500');
  });

  test('long live documents are projected to question-relevant lines before prompt injection', () => {
    const source = read('src/modules/ai/guildKnowledge.ts');
    expect(source).toContain('projectLiveServerContent');
    expect(source).toContain("provenance.sourceKind === 'LIVE_SERVER'");
    expect(source).toContain('isLiveServerSourceRef(provenance.sourceRef)');
    expect(source).toContain('LIVE_SERVER_MAX_PROJECTED_CHARS');
  });

  test('generated rows are lifecycle-compatible with existing gameserver deletion', () => {
    const source = read('src/modules/nitrado/repository.ts');
    const start = source.indexOf('export async function deleteSlot');
    const end = source.indexOf('export async function setStatus', start);
    const block = source.slice(start, end);
    expect(block).toContain('guildKnowledgeProvenance.deleteMany');
    expect(block).toContain('guildKnowledge.deleteMany');
    expect(block).toContain('guildKnowledgeScope.deleteMany');

    const schema = read('prisma/schema.prisma');
    const snapshotStart = schema.indexOf('model NitradoSnapshot {');
    const snapshotEnd = schema.indexOf('model NitradoSnapshotFile {', snapshotStart);
    const snapshotBlock = schema.slice(snapshotStart, snapshotEnd);
    expect(snapshotStart).toBeGreaterThanOrEqual(0);
    expect(snapshotBlock).toContain('nitradoConn     NitradoConnection     @relation(fields: [nitradoConnId], references: [id], onDelete: Cascade)');
  });
});
