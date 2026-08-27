import axios from 'axios';
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

  it('beantwortet autoritative Jahresfragen lokal ohne den Netzwerk-Adapter aufzurufen', async () => {
    installAiProviderRequestCompatibility();
    const networkAdapter = jest.fn(async () => {
      throw new Error('NETWORK_MUST_NOT_BE_CALLED');
    });
    const res = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'openai/gpt-oss-120b',
        messages: [
          { role: 'system', content: 'AUTORITATIVE ZEIT- UND DATUMSANGABEN (Europe/Berlin)' },
          { role: 'user', content: 'was für ein Jahr haben wir heute?' },
        ],
        max_tokens: 1500,
      },
      { adapter: networkAdapter as any },
    );
    expect(networkAdapter).not.toHaveBeenCalled();
    expect(res.data.choices[0].message.content).toContain(String(new Date().getUTCFullYear()));
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
