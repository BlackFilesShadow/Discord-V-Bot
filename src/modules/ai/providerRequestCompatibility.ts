import axios from 'axios';
import { composePromptWithinBudget, getTotalPromptBudget, type PromptRole } from './promptBudget';

const OPENAI_COMPATIBLE_HOSTS = new Set([
  'api.groq.com',
  'api.cerebras.ai',
  'openrouter.ai',
  'api.openai.com',
]);

const HARD_SYSTEM_MARKERS = [
  'AI_TASK_PROFILE:',
  'Du bist V-Bot Prime',
  'AUTORITATIVE ZEIT- UND DATUMSANGABEN',
  'WICHTIG – Wissensstand:',
  'DAYZ 1.29 – GEERDETE ERKLAERBASIS',
  'DAYZ 1.29 – HARTE GROUNDING-REGELN',
  'GEPRUEFTE DAYZ-ENGINE-/SERVER-KONFIGURATION:',
] as const;

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

function isKnownAiUrl(rawUrl?: string): boolean {
  const url = parseUrl(rawUrl);
  if (!url) return false;
  return (
    (OPENAI_COMPATIBLE_HOSTS.has(url.hostname) && url.pathname.endsWith('/chat/completions'))
    || (url.hostname === 'generativelanguage.googleapis.com' && url.pathname.endsWith(':generateContent'))
  );
}

function geminiModelFromPath(pathname: string): string | null {
  const match = pathname.match(/\/models\/([^/:]+):generateContent$/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

/**
 * Google hat den Legacy-Sampling-Vertrag ab Gemini 3.6 Flash fuer alle
 * nachfolgenden Gemini-Generationen abgeschafft. 3.5 Flash-Lite nutzt denselben
 * neuen Vertrag. Offizielle spaetere 3.x/4.x IDs werden deshalb kompatibel
 * normalisiert, ohne beliebige Custom-/Enterprise-Modellnamen anzufassen.
 */
function usesModernGeminiSamplingContract(model: string | null): boolean {
  if (!model) return false;
  const lower = model.toLowerCase();
  if (lower === 'gemini-3.5-flash-lite') return true;
  const match = /^gemini-(\d+)(?:\.(\d+))?-/.exec(lower);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2] ?? 0);
  return major > 3 || (major === 3 && minor >= 6);
}

function isMandatorySystemMessage(content: string, index: number): boolean {
  if (index === 0) return true;
  return HARD_SYSTEM_MARKERS.some((marker) => content.includes(marker));
}

function providerMessagePriority(role: string, content: string, index: number): number {
  if (role !== 'system') return index;
  if (content.includes('SECURITY-GRENZE FUER EXTERNE KONTEXTDATEN:')) return 90;
  if (content.includes('NITRADO-BEDIENWEG (Hosting-Prozedur, nicht DayZ-Dateisemantik):')) return 85;
  return 70;
}

function budgetOpenAiMessages(value: unknown): unknown {
  if (!Array.isArray(value) || value.length === 0) return value;
  if (!value.every((m) => isRecord(m) && typeof m.role === 'string' && typeof m.content === 'string')) return value;

  const total = value.reduce((sum, raw) => sum + ((raw as Record<string, unknown>).content as string).length, 0);
  if (total <= getTotalPromptBudget()) return value;

  const lastIndex = value.length - 1;
  return composePromptWithinBudget(value.map((raw, index) => {
    const message = raw as Record<string, unknown>;
    const role = message.role as string;
    const content = message.content as string;
    return {
      role: (role === 'assistant' || role === 'system' ? role : 'user') as PromptRole,
      content,
      source: `provider-message-${index}`,
      // Erste Systeminstruktion, harte Runtime-Regeln und aktuelle Userfrage
      // bleiben Pflicht. Optionale Systemkontexte koennen nur als ganzer Block
      // entfallen, niemals ohne ihre eigene Security-Grenze weiterleben.
      required: (role === 'system' && isMandatorySystemMessage(content, index)) || index === lastIndex,
      priority: providerMessagePriority(role, content, index),
    };
  }));
}

function budgetGeminiContents(value: unknown): unknown {
  if (!Array.isArray(value) || value.length === 0) return value;
  const entries = value.map((entry, index) => {
    if (!isRecord(entry) || !Array.isArray(entry.parts)) return null;
    const texts = entry.parts
      .filter((part): part is Record<string, unknown> => isRecord(part) && typeof part.text === 'string')
      .map((part) => part.text as string);
    if (texts.length === 0) return null;
    return { index, chars: texts.reduce((sum, text) => sum + text.length, 0) };
  });
  if (entries.some((entry) => entry === null)) return value;

  const totalBudget = getTotalPromptBudget();
  let total = (entries as Array<{ index: number; chars: number }>).reduce((sum, entry) => sum + entry.chars, 0);
  if (total <= totalBudget) return value;

  const lastIndex = value.length - 1;
  const requiredLength = (entries as Array<{ index: number; chars: number }>)
    .filter((entry) => entry.index === 0 || entry.index === lastIndex)
    .reduce((sum, entry) => sum + entry.chars, 0);
  if (requiredLength > totalBudget) {
    throw new Error(`PROMPT_BUDGET_REQUIRED_OVERFLOW:${requiredLength}/${totalBudget}`);
  }

  const dropped = new Set<number>();
  for (const entry of entries as Array<{ index: number; chars: number }>) {
    if (total <= totalBudget) break;
    if (entry.index === 0 || entry.index === lastIndex) continue;
    dropped.add(entry.index);
    total -= entry.chars;
  }
  if (total > totalBudget) throw new Error(`PROMPT_BUDGET_OVERFLOW:${total}/${totalBudget}`);
  return value.filter((_entry, index) => !dropped.has(index));
}

/**
 * Normalisiert ausschliesslich bekannte V-Bot-AI-Provider-Requests.
 * Neben Request-Kompatibilitaet erzwingt AI-9 hier die letzte, providernahe
 * Gesamtbudget-Grenze auf dem tatsaechlich versendeten Payload.
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
    if (body.messages !== undefined) body.messages = budgetOpenAiMessages(body.messages);

    if (body.max_completion_tokens === undefined && body.max_tokens !== undefined) {
      body.max_completion_tokens = body.max_tokens;
    }
    delete body.max_tokens;

    if (url.hostname === 'api.groq.com') {
      delete body.presence_penalty;
      delete body.frequency_penalty;
      if (body.temperature !== undefined && body.top_p !== undefined) delete body.top_p;
    }

    if (url.hostname === 'api.openai.com') {
      const model = typeof body.model === 'string' ? body.model : '';
      if (model.startsWith('gpt-5.6')) {
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
    const model = geminiModelFromPath(url.pathname);
    const isKnownModernModel = usesModernGeminiSamplingContract(model);

    if (!isKnownModernModel) {
      if (data.contents === undefined) return data;
      const boundedContents = budgetGeminiContents(data.contents);
      if (boundedContents === data.contents) return data;
      return { ...data, contents: boundedContents };
    }

    const body: Record<string, unknown> = { ...data };
    if (body.contents !== undefined) body.contents = budgetGeminiContents(body.contents);
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

function extractOpenAiText(data: unknown): string {
  if (!isRecord(data) || !Array.isArray(data.choices)) return '';
  const first = data.choices[0];
  if (!isRecord(first) || !isRecord(first.message)) return '';
  return typeof first.message.content === 'string' ? first.message.content.trim() : '';
}

function extractGeminiText(data: unknown): string {
  if (!isRecord(data) || !Array.isArray(data.candidates)) return '';
  const first = data.candidates[0];
  if (!isRecord(first) || !isRecord(first.content) || !Array.isArray(first.content.parts)) return '';
  return first.content.parts
    .filter((part): part is Record<string, unknown> => isRecord(part) && part.thought !== true && typeof part.text === 'string')
    .map(part => String(part.text).trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

/**
 * Vereinheitlicht Gemini-Mehrteilantworten und stellt fuer alle bekannten
 * Provider sicher, dass HTTP 200 ohne sichtbaren Text NICHT als Erfolg gilt.
 */
export function normalizeAiProviderResponse(
  requestUrl: string | undefined,
  data: unknown,
): { data: unknown; text: string } {
  const url = parseUrl(requestUrl);
  if (!url || !isKnownAiUrl(requestUrl)) return { data, text: '' };

  if (url.hostname === 'generativelanguage.googleapis.com') {
    const text = extractGeminiText(data);
    if (!text || !isRecord(data) || !Array.isArray(data.candidates) || !isRecord(data.candidates[0])) {
      return { data, text };
    }
    const candidate = data.candidates[0] as Record<string, unknown>;
    const content = isRecord(candidate.content) ? candidate.content : {};
    const normalizedCandidate = { ...candidate, content: { ...content, parts: [{ text }] } };
    return { data: { ...data, candidates: [normalizedCandidate, ...data.candidates.slice(1)] }, text };
  }

  return { data, text: extractOpenAiText(data) };
}

let installed = false;

/**
 * Installiert genau eine eng begrenzte Kompatibilitaetsschicht auf der von
 * V-Bot verwendeten Axios-Instanz. Sie normalisiert Provider-Payloads und laesst
 * leere 200-Providerantworten als retry-/fallback-faehigen Fehler weiterlaufen.
 * Die Transportgrenze interpretiert Inhalte niemals als neue Nutzerfrage:
 * Gemini kann System-Preamble und Nutzertext in einem Content zusammenfassen.
 * Lokale Zeit-/Statusantworten gehoeren ausschliesslich in answerQuestion vor
 * der Prompt-Assemblierung, nicht in einen synthetischen Netzwerk-Adapter.
 */
export function installAiProviderRequestCompatibility(): void {
  if (installed) return;
  axios.interceptors.request.use((request) => {
    request.data = normalizeAiProviderRequest(request.url, request.data);
    return request;
  });
  axios.interceptors.response.use((response) => {
    if (!isKnownAiUrl(response.config?.url)) return response;
    const normalized = normalizeAiProviderResponse(response.config?.url, response.data);
    response.data = normalized.data;
    if (!normalized.text) {
      const error = new Error('AI_PROVIDER_EMPTY_RESPONSE') as Error & {
        response?: { status: number; headers: unknown };
      };
      // 502 klassifiziert die leere Providerantwort als transienten Upstream-
      // Fehler. callAI darf denselben Provider einmal retryen und faellt danach
      // kontrolliert zum naechsten Provider weiter.
      error.response = { status: 502, headers: response.headers };
      throw error;
    }
    return response;
  });
  installed = true;
}
