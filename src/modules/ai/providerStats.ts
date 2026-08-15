import axios from 'axios';
import prisma from '../../database/prisma';
import { logger } from '../../utils/logger';
import { config } from '../../config';

/**
 * Provider-Health-Tracking + adaptive Reihenfolge.
 *
 * - recordCall(): nach jedem callAI-Versuch persistente Stats updaten
 * - getRankedProviders(): Reihenfolge nach Score statt fester Konfig-Reihenfolge
 * - getStats(): formatiert fuer Bot-Admin/DEV-Dashboard-Diagnostik
 * - probeProvider(): aktiver Health-Check mit Mini-Prompt + Latenz
 *
 * Die fruehere Discord-Ausgabe ueber /admin-aimodels ist in das Dashboard
 * migriert; dieses Modul ist weiterhin die kanonische Runtime-Datenquelle.
 */

export type ProviderName = 'groq' | 'cerebras' | 'openrouter' | 'gemini' | 'openai';

export const ALL_PROVIDERS: ProviderName[] = ['groq', 'cerebras', 'openrouter', 'gemini', 'openai'];

export interface ProviderStat {
  provider: ProviderName;
  successCount: number;
  failureCount: number;
  rateLimitCount: number;
  avgLatencyMs: number;
  successRate: number; // 0..1
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  lastError: string | null;
  configured: boolean;
}

function isConfigured(p: ProviderName): boolean {
  switch (p) {
    case 'groq': return Boolean(config.ai.groqApiKey);
    case 'cerebras': return Boolean(config.ai.cerebrasApiKey);
    case 'openrouter': return Boolean(config.ai.openrouterApiKey);
    case 'gemini': return Boolean(config.ai.geminiApiKey);
    case 'openai': return Boolean(config.ai.openaiApiKey);
  }
}

// =====================================================================
// Phase 12 + P0-Hardening: Persistente Cooldowns. Bei 429 wird der Provider
// fuer N Sekunden komplett aus der Ranking-Liste entfernt. Backoff waechst
// exponentiell: 30s -> 60s -> 120s -> max 300s.
//
// Persistierung: AiProviderStat.cooldownUntil/cooldownStreak. In-Memory
// Cache ist nur noch Beschleunigung; DB ist Source-of-Truth (Multi-Replica
// + Restart-sicher).
// =====================================================================
interface CooldownState { until: number; consecutive: number; }
const cooldowns = new Map<ProviderName, CooldownState>();
const COOLDOWN_BASE_MS = 30_000;
const COOLDOWN_MAX_MS = 300_000;
const UNAVAILABLE_COOLDOWN_MS = 15 * 60_000;

export async function hydrateCooldownsFromDb(): Promise<void> {
  try {
    const rows = await prisma.aiProviderStat.findMany({
      where: { cooldownUntil: { not: null } },
      select: { provider: true, cooldownUntil: true, cooldownStreak: true },
    });
    const seen = new Set<ProviderName>();
    for (const r of rows) {
      if (!ALL_PROVIDERS.includes(r.provider as ProviderName)) continue;
      if (!r.cooldownUntil) continue;
      const until = r.cooldownUntil.getTime();
      if (Date.now() >= until) continue;
      cooldowns.set(r.provider as ProviderName, {
        until,
        consecutive: r.cooldownStreak ?? 1,
      });
      seen.add(r.provider as ProviderName);
    }
    for (const [p] of cooldowns) {
      if (!seen.has(p) && cooldowns.get(p)!.until <= Date.now()) cooldowns.delete(p);
    }
  } catch (e) {
    logger.warn(`providerStats.hydrateCooldownsFromDb: ${(e as Error).message}`);
  }
}

let syncTimer: NodeJS.Timeout | null = null;
export function scheduleProviderCooldownSync(intervalMs = 60_000): void {
  if (syncTimer) return;
  void hydrateCooldownsFromDb();
  syncTimer = setInterval(() => { void hydrateCooldownsFromDb(); }, intervalMs);
  syncTimer.unref?.();
}

export function markRateLimited(provider: ProviderName, retryAfterMs?: number): number {
  const prev = cooldowns.get(provider);
  const consecutive = (prev?.consecutive ?? 0) + 1;
  const backoff = Math.min(COOLDOWN_BASE_MS * Math.pow(2, consecutive - 1), COOLDOWN_MAX_MS);
  const ms = retryAfterMs && retryAfterMs > 0
    ? Math.min(Math.max(retryAfterMs, 1_000), COOLDOWN_MAX_MS)
    : backoff;
  const until = Date.now() + ms;
  cooldowns.set(provider, { until, consecutive });
  logger.info(`providerStats: ${provider} cooldown ${Math.round(ms / 1000)}s (${consecutive}x 429 in Folge)`);
  persistCooldown(provider, until, '429_rate_limit', consecutive);
  return ms;
}

export function markProviderUnavailable(provider: ProviderName, reason = 'auth_or_model_error'): void {
  const until = Date.now() + UNAVAILABLE_COOLDOWN_MS;
  cooldowns.set(provider, { until, consecutive: 1 });
  logger.warn(`providerStats: ${provider} ${Math.round(UNAVAILABLE_COOLDOWN_MS / 60_000)}min deaktiviert (${reason})`);
  persistCooldown(provider, until, reason, 1);
}

function persistCooldown(provider: ProviderName, untilMs: number, reason: string, consecutive: number): void {
  void prisma.aiProviderStat.upsert({
    where: { provider },
    create: {
      provider,
      successCount: 0,
      failureCount: 0,
      rateLimitCount: 0,
      avgLatencyMs: 0,
      lastError: reason,
      cooldownUntil: new Date(untilMs),
      cooldownStreak: consecutive,
    },
    update: {
      lastError: reason,
      cooldownUntil: new Date(untilMs),
      cooldownStreak: consecutive,
    },
  }).catch((e: unknown) => logger.warn(`providerStats.persistCooldown ${provider}: ${(e as Error).message}`));
}

function isOnCooldown(provider: ProviderName): boolean {
  const c = cooldowns.get(provider);
  if (!c) return false;
  if (Date.now() >= c.until) {
    cooldowns.delete(provider);
    void prisma.aiProviderStat.update({
      where: { provider },
      data: { cooldownUntil: null, cooldownStreak: 0 },
    }).catch(() => {});
    return false;
  }
  return true;
}

export function getAllCooldowns(): Partial<Record<ProviderName, { untilMs: number; remainingMs: number; consecutive: number }>> {
  const out: Partial<Record<ProviderName, { untilMs: number; remainingMs: number; consecutive: number }>> = {};
  for (const p of ALL_PROVIDERS) {
    const c = cooldowns.get(p);
    if (c && c.until > Date.now()) out[p] = { untilMs: c.until, remainingMs: c.until - Date.now(), consecutive: c.consecutive };
  }
  return out;
}

export function clearCooldown(provider: ProviderName): void {
  cooldowns.delete(provider);
  void prisma.aiProviderStat.update({
    where: { provider },
    data: { cooldownUntil: null, cooldownStreak: 0, lastError: null },
  }).catch(() => {});
}

export async function recordCall(
  provider: ProviderName,
  result: 'success' | 'failure' | 'rateLimit',
  latencyMs: number,
  error?: string,
  opts?: { retryAfterMs?: number },
): Promise<void> {
  try {
    const existing = await prisma.aiProviderStat.findUnique({ where: { provider } });
    const prevCalls = (existing?.successCount ?? 0) + (existing?.failureCount ?? 0) + (existing?.rateLimitCount ?? 0);
    const nextAvg = prevCalls === 0
      ? latencyMs
      : Math.round(((existing?.avgLatencyMs ?? 0) * prevCalls + latencyMs) / (prevCalls + 1));

    const data = result === 'success'
      ? {
        successCount: { increment: 1 },
        avgLatencyMs: nextAvg,
        lastSuccessAt: new Date(),
        lastError: null,
        cooldownUntil: null,
        cooldownStreak: 0,
      }
      : result === 'rateLimit'
        ? {
          rateLimitCount: { increment: 1 },
          avgLatencyMs: nextAvg,
          lastFailureAt: new Date(),
          lastError: error?.slice(0, 500) ?? '429',
        }
        : {
          failureCount: { increment: 1 },
          avgLatencyMs: nextAvg,
          lastFailureAt: new Date(),
          lastError: error?.slice(0, 500) ?? 'unknown',
        };

    await prisma.aiProviderStat.upsert({
      where: { provider },
      create: {
        provider,
        successCount: result === 'success' ? 1 : 0,
        failureCount: result === 'failure' ? 1 : 0,
        rateLimitCount: result === 'rateLimit' ? 1 : 0,
        avgLatencyMs: latencyMs,
        lastSuccessAt: result === 'success' ? new Date() : null,
        lastFailureAt: result !== 'success' ? new Date() : null,
        lastError: result === 'success' ? null : error?.slice(0, 500) ?? null,
      },
      update: data,
    });

    if (result === 'rateLimit') markRateLimited(provider, opts?.retryAfterMs);
    else if (result === 'success') clearCooldown(provider);
  } catch (e) {
    logger.warn(`providerStats.recordCall(${provider}) fehlgeschlagen: ${(e as Error).message}`);
  }
}

export async function getStats(): Promise<ProviderStat[]> {
  const rows = await prisma.aiProviderStat.findMany();
  return ALL_PROVIDERS.map(provider => {
    const r = rows.find(x => x.provider === provider);
    const success = r?.successCount ?? 0;
    const failure = r?.failureCount ?? 0;
    const rate = r?.rateLimitCount ?? 0;
    const total = success + failure + rate;
    return {
      provider,
      successCount: success,
      failureCount: failure,
      rateLimitCount: rate,
      avgLatencyMs: r?.avgLatencyMs ?? 0,
      successRate: total > 0 ? success / total : 0.5,
      lastSuccessAt: r?.lastSuccessAt ?? null,
      lastFailureAt: r?.lastFailureAt ?? null,
      lastError: r?.lastError ?? null,
      configured: isConfigured(provider),
    };
  });
}

export async function getRankedProviders(): Promise<ProviderName[]> {
  const stats = await getStats();
  return stats
    .filter(s => s.configured && !isOnCooldown(s.provider))
    .sort((a, b) => {
      const scoreA = a.successRate * 1000 - a.avgLatencyMs * 0.1;
      const scoreB = b.successRate * 1000 - b.avgLatencyMs * 0.1;
      return scoreB - scoreA;
    })
    .map(s => s.provider);
}

export async function probeProvider(provider: ProviderName): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const t0 = Date.now();
  try {
    const cfg = config.ai;
    let baseUrl: string;
    let apiKey: string;
    let model: string;
    let headers: Record<string, string> = {};
    let body: unknown;

    if (provider === 'gemini') {
      if (!cfg.geminiApiKey) return { ok: false, latencyMs: 0, error: 'nicht konfiguriert' };
      baseUrl = `https://generativelanguage.googleapis.com/v1beta/models/${cfg.geminiModel}:generateContent`;
      apiKey = cfg.geminiApiKey;
      model = cfg.geminiModel;
      headers = { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' };
      body = { contents: [{ role: 'user', parts: [{ text: 'ping' }] }], generationConfig: { maxOutputTokens: 8 } };
    } else {
      const map: Record<Exclude<ProviderName, 'gemini'>, { url: string; key: string; model: string }> = {
        groq: { url: 'https://api.groq.com/openai/v1/chat/completions', key: cfg.groqApiKey, model: cfg.groqModel },
        cerebras: { url: 'https://api.cerebras.ai/v1/chat/completions', key: cfg.cerebrasApiKey, model: cfg.cerebrasModel },
        openrouter: { url: 'https://openrouter.ai/api/v1/chat/completions', key: cfg.openrouterApiKey, model: cfg.openrouterModel },
        openai: { url: 'https://api.openai.com/v1/chat/completions', key: cfg.openaiApiKey, model: cfg.openaiModel },
      };
      const p = map[provider];
      if (!p.key) return { ok: false, latencyMs: 0, error: 'nicht konfiguriert' };
      baseUrl = p.url; apiKey = p.key; model = p.model;
      headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
      body = { model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 8, temperature: 0 };
    }

    await axios.post(baseUrl, body, { headers, timeout: 10_000 });
    const latencyMs = Date.now() - t0;
    await recordCall(provider, 'success', latencyMs);
    return { ok: true, latencyMs };
  } catch (e) {
    const latencyMs = Date.now() - t0;
    const status = (e as { response?: { status?: number } })?.response?.status;
    const error = `${status ?? ''} ${(e as Error).message}`.trim().slice(0, 300);
    await recordCall(provider, status === 429 ? 'rateLimit' : 'failure', latencyMs, error);
    return { ok: false, latencyMs, error };
  }
}
