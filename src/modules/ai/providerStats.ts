import axios from 'axios';
import prisma from '../../database/prisma';
import { logger } from '../../utils/logger';
import { config } from '../../config';
import { providerSupportsTask, taskAffinity, type AiTaskProfile } from './providerCapabilities';

/**
 * Provider-Health-Tracking + adaptive Reihenfolge.
 *
 * - recordCall(): nach jedem callAI-Versuch persistente Stats updaten
 * - getRankedProviders(): Reihenfolge nach Capability + Health/Latency statt fester Konfig-Reihenfolge
 * - getStats(): formatiert fuer Bot-Admin/DEV-Dashboard-Diagnostik
 * - probeProvider(): aktiver Health-Check mit Mini-Prompt + Latenz
 *
 * Die fruehere Discord-Ausgabe ueber /admin-aimodels ist in das Dashboard
 * migriert; dieses Modul bleibt die kanonische Runtime-Datenquelle.
 */

export type ProviderName = 'groq' | 'cerebras' | 'openrouter' | 'gemini' | 'openai';

export const ALL_PROVIDERS: ProviderName[] = ['groq', 'cerebras', 'openrouter', 'gemini', 'openai'];

export interface ProviderStat {
  provider: ProviderName;
  successCount: number;
  failureCount: number;
  rateLimitCount: number;
  avgLatencyMs: number;
  successRate: number;
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

export function getConfiguredModel(p: ProviderName): string {
  switch (p) {
    case 'groq': return config.ai.groqModel;
    case 'cerebras': return config.ai.cerebrasModel;
    case 'openrouter': return config.ai.openrouterModel;
    case 'gemini': return config.ai.geminiModel;
    case 'openai': return config.ai.openaiModel;
  }
}

interface CooldownState { until: number; consecutive: number }
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

export function markProviderUnavailable(provider: ProviderName, reason: string): void {
  const until = Date.now() + UNAVAILABLE_COOLDOWN_MS;
  const consecutive = (cooldowns.get(provider)?.consecutive ?? 0) + 1;
  cooldowns.set(provider, { until, consecutive });
  logger.warn(`providerStats: ${provider} ${Math.round(UNAVAILABLE_COOLDOWN_MS / 60000)}min aus Rotation (${reason} — Key/Model pruefen)`);
  persistCooldown(provider, until, reason, consecutive);
}

function persistCooldown(provider: ProviderName, until: number, reason: string, streak: number): void {
  void prisma.aiProviderStat.update({
    where: { provider },
    data: { cooldownUntil: new Date(until), cooldownReason: reason, cooldownStreak: streak },
  }).catch((e: unknown) => {
    if ((e as { code?: string }).code === 'P2025') {
      void prisma.aiProviderStat.create({
        data: { provider, cooldownUntil: new Date(until), cooldownReason: reason, cooldownStreak: streak },
      }).catch(() => { /* ignore secondary error */ });
    }
  });
}

export function clearCooldown(provider: ProviderName): void {
  if (!cooldowns.has(provider)) return;
  cooldowns.delete(provider);
  void prisma.aiProviderStat.updateMany({
    where: { provider, cooldownUntil: { not: null } },
    data: { cooldownUntil: null, cooldownReason: null, cooldownStreak: 0 },
  }).catch(() => { /* ignore */ });
}

export function isOnCooldown(provider: ProviderName): boolean {
  const c = cooldowns.get(provider);
  if (!c) return false;
  if (Date.now() >= c.until) {
    cooldowns.delete(provider);
    return false;
  }
  return true;
}

export function getCooldownRemainingMs(provider: ProviderName): number {
  const c = cooldowns.get(provider);
  if (!c) return 0;
  return Math.max(0, c.until - Date.now());
}

export function getAllCooldowns(): Array<{ provider: ProviderName; remainingMs: number; consecutive: number }> {
  const out: Array<{ provider: ProviderName; remainingMs: number; consecutive: number }> = [];
  for (const p of ALL_PROVIDERS) {
    const c = cooldowns.get(p);
    if (c && Date.now() < c.until) {
      out.push({ provider: p, remainingMs: c.until - Date.now(), consecutive: c.consecutive });
    }
  }
  return out;
}

export async function recordCall(
  provider: ProviderName,
  outcome: 'success' | 'failure' | 'rateLimit',
  latencyMs: number,
  error?: string,
  opts?: { retryAfterMs?: number },
): Promise<void> {
  if (outcome === 'success') clearCooldown(provider);
  if (outcome === 'rateLimit') markRateLimited(provider, opts?.retryAfterMs);
  try {
    const now = new Date();
    const data: Record<string, unknown> = {};
    if (outcome === 'success') {
      data.successCount = { increment: 1 };
      data.totalLatencyMs = { increment: BigInt(Math.max(0, Math.round(latencyMs))) };
      data.lastSuccessAt = now;
    } else if (outcome === 'rateLimit') {
      data.rateLimitCount = { increment: 1 };
      data.lastFailureAt = now;
      data.lastError = (error || '429 Rate Limit').slice(0, 500);
    } else {
      data.failureCount = { increment: 1 };
      data.lastFailureAt = now;
      data.lastError = (error || 'unknown').slice(0, 500);
    }
    await prisma.aiProviderStat.upsert({
      where: { provider },
      update: data,
      create: {
        provider,
        successCount: outcome === 'success' ? 1 : 0,
        failureCount: outcome === 'failure' ? 1 : 0,
        rateLimitCount: outcome === 'rateLimit' ? 1 : 0,
        totalLatencyMs: outcome === 'success' ? BigInt(Math.max(0, Math.round(latencyMs))) : BigInt(0),
        lastSuccessAt: outcome === 'success' ? now : null,
        lastFailureAt: outcome !== 'success' ? now : null,
        lastError: outcome !== 'success' ? (error || '').slice(0, 500) : null,
      },
    });
  } catch (e) {
    logger.warn(`providerStats.recordCall fehlgeschlagen: ${String(e)}`);
  }
}

export async function getStats(): Promise<ProviderStat[]> {
  const rows = await prisma.aiProviderStat.findMany();
  const map = new Map<string, typeof rows[number]>();
  for (const r of rows) map.set(r.provider, r);
  return ALL_PROVIDERS.map((p) => {
    const r = map.get(p);
    const success = r?.successCount ?? 0;
    const fail = r?.failureCount ?? 0;
    const rate = r?.rateLimitCount ?? 0;
    const total = success + fail + rate;
    const totalLatency = r ? Number(r.totalLatencyMs) : 0;
    return {
      provider: p,
      successCount: success,
      failureCount: fail,
      rateLimitCount: rate,
      avgLatencyMs: success > 0 ? Math.round(totalLatency / success) : 0,
      successRate: total > 0 ? success / total : 0,
      lastSuccessAt: r?.lastSuccessAt ?? null,
      lastFailureAt: r?.lastFailureAt ?? null,
      lastError: r?.lastError ?? null,
      configured: isConfigured(p),
    };
  });
}

export async function getRankedProviders(task: AiTaskProfile = 'chat'): Promise<ProviderName[]> {
  const stats = await getStats();
  const primary = config.ai.provider as ProviderName;
  const candidates = stats
    .filter((s) => s.configured)
    .filter((s) => !isOnCooldown(s.provider));

  const capable = candidates.filter((s) => providerSupportsTask(s.provider, getConfiguredModel(s.provider), task));

  const scored = capable
    .map((s) => {
      const total = s.successCount + s.failureCount + s.rateLimitCount;
      const successScore = (s.successCount + 1) / (total + 2);
      const latencyScore = 1 / (1 + (s.avgLatencyMs || 1500) / 5000);
      const primaryBias = s.provider === primary ? 1.05 : 1;
      const capabilityBias = taskAffinity(s.provider, getConfiguredModel(s.provider), task);
      return { provider: s.provider, score: successScore * latencyScore * primaryBias * capabilityBias };
    })
    .sort((a, b) => b.score - a.score)
    .map((x) => x.provider);

  // Capability routing is fail-closed. A task may only be sent to a model whose
  // configured model ID explicitly advertises that task capability.
  return scored;
}

export async function probeProvider(provider: ProviderName): Promise<{
  ok: boolean;
  latencyMs: number;
  error?: string;
  reply?: string;
}> {
  if (!isConfigured(provider)) {
    return { ok: false, latencyMs: 0, error: 'Kein API-Key konfiguriert' };
  }
  const t0 = Date.now();
  try {
    let reply = '';
    if (provider === 'gemini') {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.ai.geminiModel}:generateContent`;
      const res = await axios.post(
        url,
        { contents: [{ role: 'user', parts: [{ text: 'ping' }] }], generationConfig: { maxOutputTokens: 5 } },
        { headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.ai.geminiApiKey }, timeout: 10000 },
      );
      reply = res.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    } else {
      const cfg: Record<ProviderName, { url: string; key: string; model: string } | null> = {
        groq:       { url: 'https://api.groq.com/openai/v1', key: config.ai.groqApiKey, model: config.ai.groqModel },
        cerebras:   { url: 'https://api.cerebras.ai/v1',     key: config.ai.cerebrasApiKey, model: config.ai.cerebrasModel },
        openrouter: { url: 'https://openrouter.ai/api/v1',   key: config.ai.openrouterApiKey, model: config.ai.openrouterModel },
        gemini:     null,
        openai:     { url: 'https://api.openai.com/v1',      key: config.ai.openaiApiKey, model: config.ai.openaiModel },
      };
      const c = cfg[provider];
      if (!c) return { ok: false, latencyMs: 0, error: 'Unbekannter Provider' };
      const res = await axios.post(
        `${c.url}/chat/completions`,
        { model: c.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 5 },
        {
          headers: { Authorization: `Bearer ${c.key}`, 'Content-Type': 'application/json' },
          timeout: 10000,
        },
      );
      reply = res.data.choices?.[0]?.message?.content || '';
    }
    const latency = Date.now() - t0;
    return { ok: true, latencyMs: latency, reply: reply.slice(0, 80) };
  } catch (e) {
    const latency = Date.now() - t0;
    const err = e as { response?: { status?: number }; message?: string };
    const msg = err?.response?.status ? `HTTP ${err.response.status}` : (err?.message || String(e));
    return { ok: false, latencyMs: latency, error: msg };
  }
}
