import fs from 'node:fs';
import path from 'node:path';
import { providerSupportsTask } from '../../src/modules/ai/providerCapabilities';

describe('AI provider configuration routing', () => {
  it('gibt einer leeren/unconfigured Modell-ID auch fuer Chat keine Capability', () => {
    expect(providerSupportsTask('groq', '', 'chat')).toBe(false);
    expect(providerSupportsTask('openrouter', '   ', 'chat')).toBe(false);
    expect(providerSupportsTask('gemini', '', 'reasoning')).toBe(false);
  });

  it('stellt im Runtime-Fallback keine Default-Modell-ID fuer Provider ohne Key bereit', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/modules/ai/providerStats.ts'), 'utf8');
    expect(source).toContain("if (!isConfigured(p)) return '';");

    const aiHandler = fs.readFileSync(path.join(process.cwd(), 'src/modules/ai/aiHandler.ts'), 'utf8');
    expect(aiHandler).toContain('providerSupportsTask(p, getConfiguredModel(p), task)');
  });
});
