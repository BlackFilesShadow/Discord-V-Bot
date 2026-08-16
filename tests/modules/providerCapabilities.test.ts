import fs from 'node:fs';
import path from 'node:path';
import {
  getProviderCapabilityProfile,
  inferAiTaskProfile,
  providerSupportsTask,
  taskAffinity,
} from '../../src/modules/ai/providerCapabilities';

describe('AI provider capability registry', () => {
  it('kennt die verifizierten GPT-OSS Capabilities bei Groq', () => {
    const p = getProviderCapabilityProfile('groq', 'openai/gpt-oss-120b');
    expect(p.knownModel).toBe(true);
    expect(p.capabilities).toEqual(expect.objectContaining({ has: expect.any(Function) }));
    expect(providerSupportsTask('groq', 'openai/gpt-oss-120b', 'structured')).toBe(true);
    expect(providerSupportsTask('groq', 'openai/gpt-oss-120b', 'reasoning')).toBe(true);
    expect(providerSupportsTask('groq', 'openai/gpt-oss-120b', 'tool')).toBe(true);
  });

  it('kennt die verifizierten GPT-OSS Capabilities bei Cerebras', () => {
    expect(providerSupportsTask('cerebras', 'gpt-oss-120b', 'structured')).toBe(true);
    expect(providerSupportsTask('cerebras', 'gpt-oss-120b', 'reasoning')).toBe(true);
    expect(providerSupportsTask('cerebras', 'gpt-oss-120b', 'long_context')).toBe(true);
    expect(taskAffinity('cerebras', 'gpt-oss-120b', 'fast')).toBeGreaterThan(1);
  });

  it('kennt Gemini 3.6 Flash als structured/tool/long-context Provider', () => {
    expect(providerSupportsTask('gemini', 'gemini-3.6-flash', 'structured')).toBe(true);
    expect(providerSupportsTask('gemini', 'gemini-3.6-flash', 'tool')).toBe(true);
    expect(providerSupportsTask('gemini', 'gemini-3.6-flash', 'long_context')).toBe(true);
  });

  it('bleibt fuer unbekannte/custom Modelle fail-conservative', () => {
    const p = getProviderCapabilityProfile('openrouter', 'custom/company-secret-model');
    expect(p.knownModel).toBe(false);
    expect(providerSupportsTask('openrouter', p.model, 'chat')).toBe(true);
    expect(providerSupportsTask('openrouter', p.model, 'structured')).toBe(false);
    expect(providerSupportsTask('openrouter', p.model, 'tool')).toBe(false);
    expect(providerSupportsTask('openrouter', p.model, 'long_context')).toBe(false);
  });

  it('ueberclaimt OpenAI Luna nicht ohne exakten Modellvertrag', () => {
    expect(providerSupportsTask('openai', 'gpt-5.6-luna', 'chat')).toBe(true);
    expect(providerSupportsTask('openai', 'gpt-5.6-luna', 'fast')).toBe(true);
    expect(providerSupportsTask('openai', 'gpt-5.6-luna', 'structured')).toBe(false);
    expect(providerSupportsTask('openai', 'gpt-5.6-luna', 'tool')).toBe(false);
  });
});

describe('AI task classifier', () => {
  it('erkennt strukturierte JSON-Aufgaben', () => {
    expect(inferAiTaskProfile([
      { role: 'system', content: 'Antworte AUSSCHLIESSLICH mit reinem JSON. Format: {"ok":true}' },
      { role: 'user', content: 'analysiere das' },
    ])).toBe('structured');
  });

  it('erkennt Uebersetzung als Fast-Task', () => {
    expect(inferAiTaskProfile([
      { role: 'system', content: 'Uebersetze den folgenden Text nach de.' },
      { role: 'user', content: 'hello' },
    ])).toBe('fast');
  });

  it('erkennt technischen DayZ/Nitrado-Kontext als Reasoning', () => {
    expect(inferAiTaskProfile([
      { role: 'system', content: 'DayZ Nitrado technische Konfiguration' },
      { role: 'user', content: 'Warum spawnt das Event nicht?' },
    ])).toBe('reasoning');
  });

  it('stuft sehr grossen Kontext als long_context ein', () => {
    expect(inferAiTaskProfile([
      { role: 'system', content: 'x'.repeat(25_000) },
      { role: 'user', content: 'fasse zusammen' },
    ])).toBe('long_context');
  });

  it('bleibt bei ambigen normalen Chats konservativ auf chat', () => {
    expect(inferAiTaskProfile([{ role: 'user', content: 'Hallo, wie geht es dir?' }])).toBe('chat');
  });

  it('providerStats nimmt einen Task entgegen und kombiniert Capability mit Health', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/modules/ai/providerStats.ts'), 'utf8');
    expect(source).toContain("getRankedProviders(task: AiTaskProfile = 'chat')");
    expect(source).toContain('providerSupportsTask');
    expect(source).toContain('taskAffinity');
  });

  it('aiHandler leitet den erkannten Task in das Provider-Ranking weiter', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/modules/ai/aiHandler.ts'), 'utf8');
    expect(source).toContain('inferAiTaskProfile(messages)');
    expect(source).toContain('getProviderOrder(task)');
    expect(source).toContain('getRankedProviders(task)');
  });
});
