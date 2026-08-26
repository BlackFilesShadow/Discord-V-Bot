import {
  AI_MODEL_DEFAULTS,
  AI_PROVIDER_NAMES,
  isKnownLegacyAiModel,
  parseAiProvider,
  resolveAiModel,
} from '../../src/modules/ai/modelRegistry';

describe('AI model registry', () => {
  it('hat genau die unterstuetzten Provider als zentrale Registry', () => {
    expect(AI_PROVIDER_NAMES).toEqual(['groq', 'cerebras', 'openrouter', 'gemini', 'openai']);
  });

  it('verwendet produktionsfaehige aktuelle Defaults fuer die kritischen Provider', () => {
    expect(AI_MODEL_DEFAULTS.groq).toBe('openai/gpt-oss-120b');
    expect(AI_MODEL_DEFAULTS.cerebras).toBe('gpt-oss-120b');
    expect(AI_MODEL_DEFAULTS.gemini).toBe('gemini-3.7-flash');
    expect(AI_MODEL_DEFAULTS.openai).toBe('gpt-5.6-luna');
  });

  it('migriert bekannte abgeschaltete oder veraltete Legacy-Modelle kontrolliert', () => {
    expect(resolveAiModel('groq', 'llama-3.3-70b-versatile')).toBe('openai/gpt-oss-120b');
    expect(resolveAiModel('cerebras', 'llama-3.3-70b')).toBe('gpt-oss-120b');
    expect(resolveAiModel('gemini', 'gemini-2.0-flash')).toBe('gemini-3.7-flash');
    expect(resolveAiModel('gemini', 'gemini-2.0-flash-lite')).toBe('gemini-3.5-flash-lite');
    expect(resolveAiModel('openai', 'gpt-4')).toBe('gpt-5.6-luna');
    expect(resolveAiModel('openai', 'gpt-5.4-mini')).toBe('gpt-5.6-luna');
  });

  it('laesst stabile oder unbekannte explizite Modelle unveraendert', () => {
    expect(resolveAiModel('gemini', 'gemini-3.6-flash')).toBe('gemini-3.6-flash');
    expect(resolveAiModel('groq', 'enterprise/custom-model')).toBe('enterprise/custom-model');
    expect(resolveAiModel('cerebras', 'dedicated/private-model')).toBe('dedicated/private-model');
  });

  it('liefert bei leerer Modellkonfiguration den zentralen Default', () => {
    expect(resolveAiModel('groq', '')).toBe(AI_MODEL_DEFAULTS.groq);
    expect(resolveAiModel('gemini', '   ')).toBe(AI_MODEL_DEFAULTS.gemini);
    expect(resolveAiModel('openai', '   ')).toBe(AI_MODEL_DEFAULTS.openai);
  });

  it('erkennt bekannte Legacy-IDs explizit', () => {
    expect(isKnownLegacyAiModel('groq', 'llama-3.3-70b-versatile')).toBe(true);
    expect(isKnownLegacyAiModel('openai', 'gpt-4')).toBe(true);
    expect(isKnownLegacyAiModel('openai', 'gpt-5.4-mini')).toBe(true);
    expect(isKnownLegacyAiModel('openrouter', 'meta-llama/llama-3.3-70b-instruct:free')).toBe(false);
  });

  it('validiert AI_PROVIDER fail-closed statt unbekannte Werte zu casten', () => {
    expect(parseAiProvider('GROQ')).toBe('groq');
    expect(parseAiProvider(' gemini ')).toBe('gemini');
    expect(parseAiProvider('')).toBe('groq');
    expect(() => parseAiProvider('unknown-provider')).toThrow(/Ungueltiger AI_PROVIDER/);
  });
});
