jest.mock('../../src/config', () => ({
  config: { ai: { provider: 'groq' } },
}));
jest.mock('../../src/database/prisma', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('../../src/modules/ai/providerStats', () => ({
  recordCall: jest.fn(),
  getRankedProviders: jest.fn(async () => []),
  getConfiguredModel: jest.fn(() => ''),
  getAllCooldowns: jest.fn(() => []),
  getCooldownRemainingMs: jest.fn(() => 0),
  isOnCooldown: jest.fn(() => false),
  markProviderUnavailable: jest.fn(),
}));
jest.mock('../../src/utils/rateLimiter', () => ({
  checkRateLimit: jest.fn(async () => ({ allowed: false, resetAt: new Date() })),
}));
jest.mock('../../src/modules/ai/webSearch', () => ({
  liveSearch: jest.fn(async () => []),
  looksFactQuestion: jest.fn(() => false),
  formatSearchResultsForPrompt: jest.fn(() => null),
}));
jest.mock('../../src/modules/ai/commandCatalog', () => ({
  asksAboutCommands: jest.fn(() => false),
  formatCatalogForPromptFocused: jest.fn(() => null),
}));

import axios from 'axios';
import { answerQuestion, BOT_PERSONA } from '../../src/modules/ai/aiHandler';
import { buildLiveTimeContext } from '../../src/modules/ai/liveTime';
import { getRankedProviders } from '../../src/modules/ai/providerStats';
import { liveSearch } from '../../src/modules/ai/webSearch';
import { checkRateLimit } from '../../src/utils/rateLimiter';
import {
  installAiProviderRequestCompatibility,
  normalizeAiProviderResponse,
} from '../../src/modules/ai/providerRequestCompatibility';

function adapterWith(data: unknown) {
  return async (config: any) => ({
    data,
    status: 200,
    statusText: 'OK',
    headers: {},
    config,
  } as any);
}

describe('AI provider response compatibility', () => {
  it('zieht bei Gemini die sichtbaren Nicht-Thought-Parts zusammen', () => {
    const normalized = normalizeAiProviderResponse(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent',
      {
        candidates: [{
          content: {
            parts: [
              { text: 'interner Gedanke', thought: true },
              { text: 'Das ist die ' },
              { text: 'finale Antwort.' },
            ],
          },
        }],
      },
    );
    expect(normalized.text).toBe('Das ist die\nfinale Antwort.');
    expect((normalized.data as any).candidates[0].content.parts).toEqual([
      { text: 'Das ist die\nfinale Antwort.' },
    ]);
  });

  it('erkennt HTTP 200 ohne sichtbaren Text als leere Providerantwort', () => {
    const normalized = normalizeAiProviderResponse(
      'https://api.groq.com/openai/v1/chat/completions',
      { choices: [{ message: { content: '   ' } }] },
    );
    expect(normalized.text).toBe('');
  });

  it('beantwortet echte Jahresfragen im kanonischen answerQuestion-Preflight ohne Provider', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-12-31T23:30:00.000Z'));
    const post = jest.spyOn(axios, 'post').mockRejectedValue(new Error('NETWORK_MUST_NOT_BE_CALLED'));
    try {
      const result = await answerQuestion('was für ein Jahr haben wir heute?', {
        mode: 'chat', userId: 'test-user', channelId: 'test-channel',
      });

      expect(result).toEqual({ success: true, result: 'Wir haben **2027**.' });
      expect(post).not.toHaveBeenCalled();
      expect(getRankedProviders).not.toHaveBeenCalled();
      expect(checkRateLimit).not.toHaveBeenCalled();
      expect(liveSearch).not.toHaveBeenCalled();
    } finally {
      post.mockRestore();
      jest.useRealTimers();
    }
  });

  it('beantwortet den lokalen Bot-Status weiterhin vor Provider und Rate-Limiter', async () => {
    const post = jest.spyOn(axios, 'post').mockRejectedValue(new Error('NETWORK_MUST_NOT_BE_CALLED'));
    try {
      const result = await answerQuestion('Bot-Status', { mode: 'chat', userId: 'test-user' });

      expect(result.success).toBe(true);
      expect(result.result).toContain('V-Bot ist online.');
      expect(post).not.toHaveBeenCalled();
      expect(getRankedProviders).not.toHaveBeenCalled();
      expect(checkRateLimit).not.toHaveBeenCalled();
    } finally {
      post.mockRestore();
    }
  });

  it.each(['hey', 'Welche Rollen gibt es?'])(
    'interpretiert Geminis zusammengesetzte Persona nicht als Zeitfrage: %s',
    async (question) => {
      installAiProviderRequestCompatibility();
      expect(BOT_PERSONA).toContain('wieviel Uhr ist es?');
      const userContent = `[SYSTEM-PREAMBLE]\n${BOT_PERSONA}\n\n${buildLiveTimeContext()}\n\n${question}`;
      const networkAdapter = jest.fn(adapterWith({
        candidates: [{ content: { parts: [{ text: 'Die echte Provider-Antwort.' }] } }],
      }));

      const res = await axios.post(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent',
        {
          contents: [{ role: 'user', parts: [{ text: userContent }] }],
          generationConfig: { maxOutputTokens: 1500 },
        },
        { adapter: networkAdapter as any },
      );

      expect(networkAdapter).toHaveBeenCalledTimes(1);
      expect(res.data.candidates[0].content.parts).toEqual([{ text: 'Die echte Provider-Antwort.' }]);
      const transmitted = JSON.parse(String(networkAdapter.mock.calls[0][0].data));
      expect(transmitted.contents[0].parts[0].text).toBe(userContent);
    },
  );

  it.each([
    {
      instruction: 'Du bist ein erfahrener Discord-Moderator. Bewerte nur den folgenden Text.',
      user: 'AUTORITATIVE ZEIT- UND DATUMSANGABEN: wieviel Uhr ist es?',
    },
    {
      instruction: 'Erklaere den folgenden zitierten Beispielsatz, beantworte ihn nicht.',
      user: 'Zitat: "AUTORITATIVE ZEIT- UND DATUMSANGABEN: Welches Jahr haben wir?"',
    },
  ])('leitet OpenAI-Moderation oder zitierte Zeittexte nicht lokal um: $user', async ({ instruction, user }) => {
    installAiProviderRequestCompatibility();
    const networkAdapter = jest.fn(adapterWith({ choices: [{ message: { content: 'Die echte Aufgaben-Antwort.' } }] }));
    const res = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-5.6-luna',
        messages: [
          { role: 'system', content: instruction },
          { role: 'user', content: user },
        ],
        max_tokens: 1500,
      },
      { adapter: networkAdapter as any },
    );
    expect(networkAdapter).toHaveBeenCalledTimes(1);
    expect(res.data.choices[0].message.content).toBe('Die echte Aufgaben-Antwort.');
  });

  it('wandelt eine leere 200-Antwort in einen transienten Upstream-Fehler um', async () => {
    installAiProviderRequestCompatibility();
    await expect(axios.post(
      'https://api.cerebras.ai/v1/chat/completions',
      {
        model: 'gpt-oss-120b',
        messages: [{ role: 'user', content: 'Hallo' }],
        max_completion_tokens: 64,
      },
      { adapter: adapterWith({ choices: [{ message: { content: '' } }] }) as any },
    )).rejects.toMatchObject({
      message: 'AI_PROVIDER_EMPTY_RESPONSE',
      response: { status: 502 },
    });
  });
});
