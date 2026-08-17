import fs from 'fs';
import path from 'path';

const read = (relative: string): string => fs.readFileSync(path.join(process.cwd(), relative), 'utf8');

describe('AI-11 knowledge provenance architecture', () => {
  it('hat eine additive Provenance-Sidecar-Migration ohne SetNull-Semantik', () => {
    const migration = read('prisma/migrations/20260817013000_ai_11_knowledge_provenance/migration.sql');
    expect(migration).toContain('CREATE TABLE "GuildKnowledgeProvenance"');
    expect(migration).toContain('"sourceKind" TEXT NOT NULL');
    expect(migration).toContain('"trustLevel" TEXT NOT NULL');
    expect(migration).toContain('"observedAt" TIMESTAMP(3) NOT NULL');
    expect(migration).toContain('"validUntil" TIMESTAMP(3)');
    expect(migration).not.toMatch(/SET\s+NULL/i);
  });

  it('schliesst EXPIRED vor dem Scoring aus und wendet Quality erst danach an', () => {
    const source = read('src/modules/ai/guildKnowledge.ts');
    const provenancePos = source.indexOf('getKnowledgeProvenanceMap(guildId, scoped)');
    const expiredPos = source.indexOf("freshness !== 'EXPIRED'", provenancePos);
    const scorePos = source.indexOf('scoreKnowledge(eligible, question, provenanceMap)', expiredPos);
    expect(provenancePos).toBeGreaterThan(-1);
    expect(expiredPos).toBeGreaterThan(provenancePos);
    expect(scorePos).toBeGreaterThan(expiredPos);
    expect(source).toContain('baseHybrid * provenance.qualityFactor');
  });

  it('validiert persistierte Provenance beim Lesen erneut und faellt konservativ zurueck', () => {
    const source = read('src/modules/ai/knowledgeProvenance.ts');
    expect(source).toContain('const validated = validateKnowledgeProvenance');
    expect(source).toContain('legacyKnowledgeProvenance(row.createdAt, now)');
    expect(source).toContain("AUTHORITATIVE erfordert eine konkrete sourceRef");
    expect(source).toContain('observedAt darf nicht in der Zukunft liegen');
  });

  it('speichert manuelle und importierte Provenance in derselben Knowledge-Transaktion', () => {
    const source = read('src/modules/ai/guildKnowledge.ts');
    expect(source).toContain('tx.guildKnowledgeProvenance.create');
    expect(source).toContain("sourceKind: 'OWNER_CURATED'");
    expect(source).toContain("sourceKind: 'IMPORTED'");
    expect(source).toContain("trustLevel: 'UNVERIFIED'");
  });

  it('entfernt Provenance vor dem physisch geloeschten servergescoppten Knowledge', () => {
    const source = read('src/modules/nitrado/repository.ts');
    const deleteStart = source.indexOf('export async function deleteSlot');
    const deleteEnd = source.indexOf('export async function setStatus', deleteStart);
    const block = source.slice(deleteStart, deleteEnd);
    const provenanceDelete = block.indexOf('guildKnowledgeProvenance.deleteMany');
    const knowledgeDelete = block.indexOf('guildKnowledge.deleteMany');
    expect(provenanceDelete).toBeGreaterThan(-1);
    expect(knowledgeDelete).toBeGreaterThan(provenanceDelete);
  });

  it('exponiert Source/Trust/Freshness sichtbar im kanonischen Bot-Admin', () => {
    const route = read('src/dashboard/routes/v2/botAdminKnowledge.ts');
    const ui = read('dashboard-ui/src/components/BotAdminKnowledgeScoped.tsx');
    expect(route).toContain('sourceKinds: KNOWLEDGE_SOURCE_KINDS');
    expect(route).toContain('trustLevels: KNOWLEDGE_TRUST_LEVELS');
    expect(ui).toContain('Knowledge Quellentyp');
    expect(ui).toContain('Knowledge Vertrauensstufe');
    expect(ui).toContain('Source-Age:');
    expect(ui).toContain('Gültig bis');
  });
});
