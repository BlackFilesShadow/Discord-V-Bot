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
 * we explicitly verified against current official provider documentation.
 * Unknown/custom model IDs get chat-only behavior rather than guessed tools,
 * structured outputs or context limits.
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

  if (provider === 'gemini' && lower === 'gemini-3.6-flash') {
    return {
      provider, model,
      capabilities: caps('chat', 'fast', 'structured', 'reasoning', 'long_context', 'tool'),
      affinity: { fast: 1.12, long_context: 1.18, structured: 1.06 },
      knownModel: true,
    };
  }

  // OpenAI Luna is kept conservative here: the current OpenAI platform
  // documents it as a high-volume GPT-5.6 option, but model-specific capability
  // metadata is not hard-coded beyond chat/fast until an exact model contract is
  // available through the provider API/docs.
  if (provider === 'openai' && lower === 'gpt-5.6-luna') {
    return {
      provider, model,
      capabilities: caps('chat', 'fast'),
      affinity: { fast: 1.08 },
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
 * Deterministic task classifier used by callAI. It deliberately detects only
 * strong signals; ambiguous prompts stay on `chat` instead of over-routing.
 */
export function inferAiTaskProfile(messages: Array<{ role: string; content: string }>): AiTaskProfile {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => String(m.content || ''))
    .join('\n')
    .toLowerCase();
  const chars = messages.reduce((sum, m) => sum + String(m.content || '').length, 0);

  if (chars >= 24_000) return 'long_context';
  if (/ausschliesslich[^\n]{0,120}json|ausschließlich[^\n]{0,120}json|response[_ -]?format|json schema/.test(system)) {
    return 'structured';
  }
  if (/übersetze|uebersetze|translation|translate/.test(system)) return 'fast';
  if (/dayz|nitrado|technisch|analysiere den kontext|moderationshinweis|reasoning/.test(system)) return 'reasoning';
  return 'chat';
}
