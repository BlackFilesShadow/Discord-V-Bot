import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('AI DayZ conversation isolation architecture', () => {
  const messageCreate = read('src/events/messageCreate.ts');
  const catalog = read('src/modules/ai/dayz129Catalog.ts');
  const handler = read('src/modules/ai/aiHandler.ts');

  it('does not scan arbitrary old bot answers to reinterpret the current question', () => {
    expect(messageCreate).not.toContain('recentBotMessages');
    expect(messageCreate).toContain('referencedBotMessage');
    expect(messageCreate).toContain('isDayzConversationDomain(referencedBotMessage.content)');
  });

  it('only builds channel/server context for domains that explicitly permit it', () => {
    expect(messageCreate).toContain('mayUseExternalConversationContext(aiQuestion)');
    expect(messageCreate).toContain('isMemoryTurnCompatible(aiQuestion, txt)');
    expect(messageCreate).toContain('const serverUserCtx = mayUseExternalConversationContext(aiQuestion)');
  });

  it('keeps the provider layer fail-closed for general external context', () => {
    expect(handler).toContain('const context = mayUseExternalConversationContext(question) ? guardContext.context : null;');
    expect(handler).toContain('const hallucinationGuard = dayzDomain ? guardContext.guard : null;');
  });

  it('requires explicit DayZ/catalog intent or a technical known identifier before catalog preflight', () => {
    expect(catalog).toContain('function explicitCatalogIntent');
    expect(catalog).toContain('hasKnownTechnicalIdentifier');
    expect(catalog).toContain('if (!explicitCatalogIntent(question)) return null;');
  });

  it('does not accept generic "kannst du" wording as implicit DayZ follow-up intent', () => {
    const followupSection = catalog.slice(catalog.indexOf('function looksReferentialFollowUp'), catalog.indexOf('/**\n * AI-13 Boundary'));
    expect(followupSection).not.toContain('kannst du');
  });
});
