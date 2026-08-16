import fs from 'node:fs';
import path from 'node:path';
import { normalizeAiProviderRequest } from '../../src/modules/ai/providerRequestCompatibility';

describe('AI provider request compatibility', () => {
  it('normalisiert Groq auf max_completion_tokens und entfernt nicht unterstuetzte Penalties', () => {
    const input = {
      model: 'openai/gpt-oss-120b',
      messages: [{ role: 'user', content: 'test' }],
      max_tokens: 1500,
      temperature: 0.85,
      top_p: 0.92,
      presence_penalty: 0.6,
      frequency_penalty: 0.4,
    };

    const output = normalizeAiProviderRequest(
      'https://api.groq.com/openai/v1/chat/completions',
      input,
    ) as Record<string, unknown>;

    expect(output).toEqual({
      model: 'openai/gpt-oss-120b',
      messages: input.messages,
      max_completion_tokens: 1500,
      temperature: 0.85,
    });
    expect(input).toHaveProperty('max_tokens', 1500);
    expect(input).toHaveProperty('presence_penalty', 0.6);
  });

  it('behaelt ein bereits modernes Tokenlimit und ueberschreibt es nicht mit max_tokens', () => {
    const output = normalizeAiProviderRequest(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'openai/gpt-oss-120b',
        max_completion_tokens: 777,
        max_tokens: 1500,
      },
    ) as Record<string, unknown>;

    expect(output.max_completion_tokens).toBe(777);
    expect(output).not.toHaveProperty('max_tokens');
  });

  it('behaelt bei Cerebras unterstuetzte Penalties und modernisiert nur das Tokenlimit', () => {
    const input = {
      model: 'gpt-oss-120b',
      max_tokens: 1200,
      temperature: 0.7,
      top_p: 0.9,
      presence_penalty: 0.2,
      frequency_penalty: 0.1,
    };

    expect(normalizeAiProviderRequest(
      'https://api.cerebras.ai/v1/chat/completions',
      input,
    )).toEqual({
      model: 'gpt-oss-120b',
      max_completion_tokens: 1200,
      temperature: 0.7,
      top_p: 0.9,
      presence_penalty: 0.2,
      frequency_penalty: 0.1,
    });
  });

  it('modernisiert OpenRouter ohne provider-spezifische Felder unnoetig zu entfernen', () => {
    const input = {
      model: 'meta-llama/llama-3.3-70b-instruct:free',
      max_tokens: 900,
      temperature: 0.8,
      top_p: 0.95,
      presence_penalty: 0.3,
      frequency_penalty: 0.2,
    };

    const output = normalizeAiProviderRequest(
      'https://openrouter.ai/api/v1/chat/completions',
      input,
    ) as Record<string, unknown>;

    expect(output).toEqual({
      model: input.model,
      max_completion_tokens: 900,
      temperature: 0.8,
      top_p: 0.95,
      presence_penalty: 0.3,
      frequency_penalty: 0.2,
    });
    expect(output).not.toHaveProperty('max_tokens');
  });

  it('sendet GPT-5.6 ueber Chat Completions konservativ ohne alte Sampling-/Penalty-Tuningwerte', () => {
    const input = {
      model: 'gpt-5.6-luna',
      max_tokens: 1500,
      temperature: 0.85,
      top_p: 0.92,
      presence_penalty: 0.6,
      frequency_penalty: 0.4,
      messages: [{ role: 'user', content: 'Hallo' }],
    };

    expect(normalizeAiProviderRequest(
      'https://api.openai.com/v1/chat/completions',
      input,
    )).toEqual({
      model: 'gpt-5.6-luna',
      max_completion_tokens: 1500,
      messages: input.messages,
    });
  });

  it('entfernt bei den bekannten modernen Gemini-Modellen alte Sampling-Parameter und behaelt das Output-Limit', () => {
    const input = {
      contents: [{ role: 'user', parts: [{ text: 'Hallo' }] }],
      generationConfig: {
        maxOutputTokens: 1500,
        temperature: 0.85,
        topP: 0.92,
        topK: 40,
        stopSequences: ['STOP'],
      },
    };

    expect(normalizeAiProviderRequest(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent',
      input,
    )).toEqual({
      contents: input.contents,
      generationConfig: {
        maxOutputTokens: 1500,
        stopSequences: ['STOP'],
      },
    });
    expect(input.generationConfig.temperature).toBe(0.85);
  });

  it('veraendert unbekannte oder explizite Gemini-Modelle nicht eigenmaechtig', () => {
    const input = {
      contents: [{ role: 'user', parts: [{ text: 'Hallo' }] }],
      generationConfig: {
        maxOutputTokens: 900,
        temperature: 0.4,
        topP: 0.8,
        topK: 20,
      },
    };

    expect(normalizeAiProviderRequest(
      'https://generativelanguage.googleapis.com/v1beta/models/custom-enterprise-model:generateContent',
      input,
    )).toBe(input);
  });

  it('laesst Nicht-AI-Requests und ungueltige URLs unangetastet', () => {
    const payload = { max_tokens: 123, foo: 'bar' };
    expect(normalizeAiProviderRequest('https://api.nitrado.net/services', payload)).toBe(payload);
    expect(normalizeAiProviderRequest('https://discord.com/api/v10/gateway', payload)).toBe(payload);
    expect(normalizeAiProviderRequest('not-a-url', payload)).toBe(payload);
    expect(normalizeAiProviderRequest(undefined, payload)).toBe(payload);
  });

  it('laesst primitive Payloads unangetastet', () => {
    expect(normalizeAiProviderRequest('https://api.groq.com/openai/v1/chat/completions', 'raw')).toBe('raw');
    expect(normalizeAiProviderRequest('https://api.groq.com/openai/v1/chat/completions', null)).toBeNull();
  });

  it('installiert die Kompatibilitaet beim Start unmittelbar nach der Production-ENV-Pruefung', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../src/index.ts'), 'utf8');
    expect(source).toContain("import { installAiProviderRequestCompatibility } from './modules/ai/providerRequestCompatibility'");
    expect(source.indexOf('assertProductionEnv();')).toBeGreaterThan(-1);
    expect(source.indexOf('installAiProviderRequestCompatibility();')).toBeGreaterThan(source.indexOf('assertProductionEnv();'));
    expect(source.indexOf('installAiProviderRequestCompatibility();')).toBeLessThan(source.indexOf('await prisma.$connect();'));
  });
});
