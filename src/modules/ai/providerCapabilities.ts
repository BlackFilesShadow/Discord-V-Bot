import type { ProviderName } from './providerStats';

export type AiTaskProfile = 'chat' | 'fast' | 'structured' | 'reasoning' | 'long_context' | 'tool';
export type AiCapability = AiTaskProfile;

export interface ProviderCapabilityProfile {
  provider: ProviderName;
  model: string;
  capabilities: ReadonlySet<AiCapability>;
  /** Optional task affinity. 1 = neutral; >1 means preferred when health is equal. */
  affinity: Partial<Record<AiTaskProfile, number>>;
  knownModel: boolean;
}

const caps = (...values: AiCapability[]): ReadonlySet<AiCapability> => new Set(values);

/**
 * Capabilities are intentionally conservative and only asserted for model IDs
 * explicitly verified against current official provider documentation.
 * Unknown/custom model IDs get chat-only behavior rather than guessed tools,
 * structured outputs, reasoning behavior, or context limits.
 */
export function getProviderCapabilityProfile(provider: ProviderName, rawModel: string): ProviderCapabilityProfile {
  const model = String(rawModel || '').trim();
  const lower = model.toLowerCase();

  if (provider === 'groq' && lower === 'openai/gpt-oss-120b') {
    return {
      provider, model,
      capabilities: caps('chat', 'fast', 'structured', 'reasoning', 'long_context', 'tool'),
      affinity: { fast: 1.18, reasoning: 1.08, structured: 1.08 },
      knownModel: true,
    };
  }

  if (provider === 'cerebras' && lower === 'gpt-oss-120b') {
    return {
      provider, model,
      capabilities: caps('chat', 'fast', 'structured', 'reasoning', 'long_context', 'tool'),
      affinity: { fast: 1.2, reasoning: 1.08, structured: 1.08 },
      knownModel: true,
    };
  }

  if (provider === 'gemini' && (lower === 'gemini-3.7-flash' || lower === 'gemini-3.6-flash')) {
    return {
      provider, model,
      capabilities: caps('chat', 'fast', 'structured', 'reasoning', 'long_context', 'tool'),
      affinity: { fast: 1.12, long_context: 1.18, structured: 1.06 },
      knownModel: true,
    };
  }

  if (provider === 'openai' && lower === 'gpt-5.6-luna') {
    return {
      provider, model,
      capabilities: caps('chat', 'fast', 'structured', 'reasoning', 'long_context', 'tool'),
      affinity: { fast: 1.08, long_context: 1.16, structured: 1.06, reasoning: 1.04 },
      knownModel: true,
    };
  }

  // OpenRouter can point at arbitrary upstream models and user-configured IDs.
  // Never infer provider-independent features from the gateway name alone.
  return {
    provider, model,
    capabilities: caps('chat'),
    affinity: {},
    knownModel: false,
  };
}

export function providerSupportsTask(provider: ProviderName, model: string, task: AiTaskProfile): boolean {
  return getProviderCapabilityProfile(provider, model).capabilities.has(task);
}

export function taskAffinity(provider: ProviderName, model: string, task: AiTaskProfile): number {
  return getProviderCapabilityProfile(provider, model).affinity[task] ?? 1;
}

/**
 * Deterministic classifier for generic callAI callsites.
 *
 * Only the FIRST system message is treated as the trusted task instruction.
 * Later system messages can contain server/RAG/web/user-derived context and must
 * never be able to steer provider selection. DayZ technical routing is supplied
 * explicitly by answerQuestion via the internal AI_TASK_PROFILE marker.
 */
export function inferAiTaskProfile(messages: Array<{ role: string; content: string }>): AiTaskProfile {
  const chars = messages.reduce((sum, m) => sum + String(m.content || '').length, 0);
  if (chars >= 24_000) return 'long_context';

  const firstSystem = String(messages.find((m) => m.role === 'system')?.content || '').toLowerCase();
  if (/^ai_task_profile:\s*reasoning\b/.test(firstSystem)) return 'reasoning';
  if (/ausschliesslich[^\n]{0,160}json|ausschließlich[^\n]{0,160}json|response[_ -]?format|json schema/.test(firstSystem)) {
    return 'structured';
  }
  if (/^übersetze\b|^uebersetze\b|\btranslation task\b|\btranslate the following\b/.test(firstSystem)) {
    return 'fast';
  }
  if (/analysiere den kontext|moderationshinweis|erfahrener discord-moderator|reasoning task/.test(firstSystem)) {
    return 'reasoning';
  }
  return 'chat';
}
