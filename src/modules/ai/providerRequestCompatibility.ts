import axios from 'axios';

const OPENAI_COMPATIBLE_HOSTS = new Set([
  'api.groq.com',
  'api.cerebras.ai',
  'openrouter.ai',
  'api.openai.com',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseUrl(rawUrl?: string): URL | null {
  if (!rawUrl) return null;
  try {
    return new URL(rawUrl);
  } catch {
    return null;
  }
}

/**
 * Normalisiert ausschliesslich bekannte V-Bot-AI-Provider-Requests.
 *
 * Hintergrund:
 * - mehrere OpenAI-kompatible Provider haben `max_tokens` inzwischen zugunsten
 *   von `max_completion_tokens` abgekündigt;
 * - Groq akzeptiert die im alten V-Bot-Body gesetzten Presence-/Frequency-
 *   Penalties nicht als unterstuetzte Modellparameter;
 * - Gemini 3.6 Flash / 3.5 Flash-Lite verlangen das Entfernen der alten
 *   Sampling-Parameter temperature/top_p/top_k.
 *
 * Die Funktion ist absichtlich rein: keine Mutation des Eingabeobjekts und kein
 * Provider-Fallback/Retry. Routing bleibt Aufgabe von aiHandler/providerStats.
 */
export function normalizeAiProviderRequest(
  requestUrl: string | undefined,
  data: unknown,
): unknown {
  const url = parseUrl(requestUrl);
  if (!url || !isRecord(data)) return data;

  if (
    OPENAI_COMPATIBLE_HOSTS.has(url.hostname)
    && url.pathname.endsWith('/chat/completions')
  ) {
    const body: Record<string, unknown> = { ...data };

    if (body.max_completion_tokens === undefined && body.max_tokens !== undefined) {
      body.max_completion_tokens = body.max_tokens;
    }
    delete body.max_tokens;

    if (url.hostname === 'api.groq.com') {
      // Groq dokumentiert diese beiden Felder weiterhin, aber derzeit als von
      // keinem Modell unterstuetzt. Nicht mitsenden statt auf Ignore-Verhalten
      // oder spaetere 400er zu vertrauen.
      delete body.presence_penalty;
      delete body.frequency_penalty;

      // Groq empfiehlt temperature ODER top_p zu veraendern, nicht beide.
      if (body.temperature !== undefined && body.top_p !== undefined) {
        delete body.top_p;
      }
    }

    if (url.hostname === 'api.openai.com') {
      const model = typeof body.model === 'string' ? body.model : '';
      if (model.startsWith('gpt-5.6')) {
        // GPT-5.6 ist ein Reasoning-Modell. Bis der spaetere task-spezifische
        // Router reasoning.effort/Responses API gezielt benchmarkt, senden wir
        // nur den kleinsten stabilen Chat-Completions-Parametersatz statt alte
        // Sampling-Tuningwerte aus frueheren GPT-4-Defaults zu uebernehmen.
        delete body.temperature;
        delete body.top_p;
        delete body.presence_penalty;
        delete body.frequency_penalty;
      }
    }

    return body;
  }

  if (
    url.hostname === 'generativelanguage.googleapis.com'
    && url.pathname.endsWith(':generateContent')
  ) {
    const body: Record<string, unknown> = { ...data };
    if (!isRecord(body.generationConfig)) return body;

    const generationConfig: Record<string, unknown> = { ...body.generationConfig };
    delete generationConfig.temperature;
    delete generationConfig.topP;
    delete generationConfig.topK;
    body.generationConfig = generationConfig;
    return body;
  }

  return data;
}

let installed = false;

/**
 * Installiert genau einen eng begrenzten Request-Normalizer auf der von V-Bot
 * verwendeten Axios-Instanz. Nicht-AI-URLs werden byte-/objektsemantisch
 * unveraendert weitergereicht.
 */
export function installAiProviderRequestCompatibility(): void {
  if (installed) return;
  axios.interceptors.request.use((request) => {
    request.data = normalizeAiProviderRequest(request.url, request.data);
    return request;
  });
  installed = true;
}
