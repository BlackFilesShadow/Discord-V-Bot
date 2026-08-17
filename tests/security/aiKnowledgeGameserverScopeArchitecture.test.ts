import fs from 'fs';
import path from 'path';

const read = (relative: string): string => fs.readFileSync(path.join(process.cwd(), relative), 'utf8');

describe('AI-10 knowledge gameserver scope architecture', () => {
  it('mountet den kanonischen Knowledge-Router vor dem Legacy-BotAdmin-Router', () => {
    const source = read('src/dashboard/routes/v2.ts');
    const canonical = source.indexOf("v2Router.use('/bot-admin/knowledge'");
    const legacy = source.indexOf("v2Router.use('/bot-admin',");
    expect(canonical).toBeGreaterThan(-1);
    expect(legacy).toBeGreaterThan(-1);
    expect(canonical).toBeLessThan(legacy);
    expect(source.slice(canonical - 300, canonical + 300)).toContain('requireGlobalBotAdminIdentity');
    expect(source.slice(canonical - 300, canonical + 300)).toContain('requireBotAdmin');
  });

  it('validiert Gameserver-Scope gegen Guild, Status, Slot und Nitrado-Bindung', () => {
    const source = read('src/modules/ai/knowledgeScope.ts');
    expect(source).toContain('where: { id, guildId }');
    expect(source).toContain("row.status !== 'ACTIVE'");
    expect(source).toContain("slotState(row.slot) !== 'ACTIVE_SLOT'");
    expect(source).toContain("!row.nitradoServerId?.trim()");
    expect(source).toContain('return options.length === 1 ? options[0] : null');
    expect(source).not.toMatch(/return\s+options\[0\]\s*;/);
  });

  it('filtert Scope und abgelaufene Provenance vor dem Hybrid-Ranking', () => {
    const source = read('src/modules/ai/guildKnowledge.ts');
    const filterPos = source.indexOf('filterKnowledgeRowsForScope(all, scopeRows, nitradoConnId)');
    const provenancePos = source.indexOf('getKnowledgeProvenanceMap(guildId, scoped)', filterPos);
    const expiredPos = source.indexOf("freshness !== 'EXPIRED'", provenancePos);
    const scorePos = source.indexOf('scoreKnowledge(eligible, question, provenanceMap)', expiredPos);
    expect(filterPos).toBeGreaterThan(-1);
    expect(provenancePos).toBeGreaterThan(filterPos);
    expect(expiredPos).toBeGreaterThan(provenancePos);
    expect(scorePos).toBeGreaterThan(expiredPos);
    expect(source).toContain("scope.type === 'GAMESERVER'");
    expect(source).toContain('scopeSlot');
  });

  it('loescht servergebundenes Knowledge beim Gameserver-Delete statt es global werden zu lassen', () => {
    const source = read('src/modules/nitrado/repository.ts');
    const deleteStart = source.indexOf('export async function deleteSlot');
    const deleteEnd = source.indexOf('export async function setStatus', deleteStart);
    const block = source.slice(deleteStart, deleteEnd);
    expect(block).toContain('guildKnowledgeScope.findMany');
    expect(block).toContain('guildKnowledge.deleteMany');
    expect(block).toContain('guildKnowledgeScope.deleteMany');
    expect(block.indexOf('guildKnowledge.deleteMany')).toBeLessThan(block.indexOf('nitradoConnection.deleteMany'));
  });

  it('exponiert einen sichtbaren mobilen Gameserver-Dropdown im Bot-Admin', () => {
    const page = read('dashboard-ui/src/pages/BotAdmin.tsx');
    const ui = read('dashboard-ui/src/components/BotAdminKnowledgeScoped.tsx');
    expect(page).toContain('<BotAdminKnowledgeScoped />');
    expect(page).toContain('AI-Wissensbank');
    expect(ui).toContain('Knowledge Gameserver Scope');
    expect(ui).toContain('nitradoConnId: nitradoConnId || null');
    expect(ui).toContain('scopeType');
    expect(ui).toContain('scopeSlot');
    expect(ui).toContain('flex flex-wrap gap-2');
  });

  it('enthaelt eine additive Migration ohne SetNull-Semantik', () => {
    const migration = read('prisma/migrations/20260817011000_ai_10_knowledge_gameserver_scope/migration.sql');
    expect(migration).toContain('CREATE TABLE "GuildKnowledgeScope"');
    expect(migration).toContain('"nitradoConnId" TEXT NOT NULL');
    expect(migration).not.toMatch(/SET\s+NULL/i);
  });
});
