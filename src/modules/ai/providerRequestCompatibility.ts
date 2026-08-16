import axios from 'axios';
import { composePromptWithinBudget, getTotalPromptBudget, type PromptRole } from './promptBudget';

const OPENAI_COMPATIBLE_HOSTS = new Set([
  'api.groq.com',
  'api.cerebras.ai',
  'openrouter.ai',
  'api.openai.com',
]);

const GEMINI_MODELS_WITHOUT_LEGACY_SAMPLING = [
  'gemini-3.6-flash',
  'gemini-3.5-flash-lite',
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

function geminiModelFromPath(pathname: string): string | null {
  const match = pathname.match(/\/models\/([^/:]+):generateContent$/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function budgetOpenAiMessages(value: unknown): unknown {
  if (!Array.isArray(value) || value.length === 0) return value;
  if (!value.every((m) => isRecord(m) && typeof m.role === 'string' && typeof m.content === 'string')) return value;
  const lastIndex = value.length - 1;
  return composePromptWithinBudget(value.map((raw, index) => {
    const message = raw as Record<string, unknown>;
    const role = message.role as string;
    return {
      role: (role === 'assistant' || role === 'system' ? role : 'user') as PromptRole,
      content: message.content as string,
      source: `provider-message-${index}`,
      // Alle Systemtexte sowie die aktuelle letzte Userfrage bleiben Pflicht.
      required: role === 'system' || index === lastIndex,
      // Bei History-Ueberlauf fallen die aeltesten Turns zuerst.
      priority: index,
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
    body.messages = budgetOpenAiMessages(body.messages);

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
    const body: Record<string, unknown> = { ...data };
    body.contents = budgetGeminiContents(body.contents);

    const model = geminiModelFromPath(url.pathname);
    if (!model || !(GEMINI_MODELS_WITHOUT_LEGACY_SAMPLING as readonly string[]).includes(model)) {
      return body;
    }
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
 * verwendeten Axios-Instanz. Nicht-AI-URLs werden objektsemantisch
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
