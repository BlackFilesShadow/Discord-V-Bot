import axios from 'axios';
import prisma from '../../database/prisma';
import { logger } from '../../utils/logger';
import { config } from '../../config';
import {
  getProviderCapabilityProfile,
  providerSupportsTask,
  taskAffinity,
  type AiCapability,
  type AiTaskProfile,
} from './providerCapabilities';
import { recordAiFallback, recordAiProviderAttempt } from './aiObservability';
import { normalizeAiProviderRequest } from './providerRequestCompatibility';
import {
  classifyProviderError,
  safeProviderFailureLabel,
  type ProviderFailureKind,
} from './providerFailure';

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
  model: string;
  knownModel: boolean;
  capabilities: AiCapability[];
  successCount: number;
  failureCount: number;
  rateLimitCount: number;
  avgLatencyMs: number;
  successRate: number;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  lastError: string | null;
  configured: boolean;
  /** Aktiver Routing-Circuit, unabhaengig davon ob 429 oder Provider-/Modellfehler. */
  cooldownReason: string | null;
  cooldownRemainingMs: number;
  cooldownStreak: number;
}

export interface ProviderConfigurationHealth {
  primary: ProviderName;
  primaryConfigured: boolean;
  configuredProviders: ProviderName[];
  fallbackProviders: ProviderName[];
  configuredCount: number;
  resilience: 'unavailable' | 'single_provider' | 'redundant';
  warnings: string[];
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
  // Ein Provider ohne API-Key ist fuer die Runtime nicht konfiguriert. Der
  // Capability-Notfallpfad in aiHandler darf ihn deshalb nicht allein wegen
  // einer Default-Modell-ID wieder in die Rotation aufnehmen.
  if (!isConfigured(p)) return '';
  switch (p) {
    case 'groq': return config.ai.groqModel;
    case 'cerebras': return config.ai.cerebrasModel;
    case 'openrouter': return config.ai.openrouterModel;
    case 'gemini': return config.ai.geminiModel;
    case 'openai': return config.ai.openaiModel;
  }
}

/** Sichere Konfigurationsdiagnose: nur Namen/Modelle, niemals API-Key-Werte. */
export function getProviderConfigurationHealth(): ProviderConfigurationHealth {
  const primary = config.ai.provider as ProviderName;
  const configuredProviders = ALL_PROVIDERS.filter(isConfigured);
  const warnings: string[] = [];

  if (configuredProviders.length === 0) {
    warnings.push('Kein AI-Provider-API-Key konfiguriert. Externe KI-Antworten sind nicht verfuegbar; andere Botfunktionen bleiben nutzbar.');
  } else if (configuredProviders.length === 1) {
    warnings.push('Nur ein AI-Provider ist konfiguriert; bei dessen Quota-/Billing-Ausfall gibt es keinen Fallback.');
  }
  if (!configuredProviders.includes(primary)) {
    warnings.push(`Der gewaehlte Primaerprovider ${primary} hat keinen nutzbaren API-Key.`);
  }
  for (const provider of configuredProviders) {
    const profile = getProviderCapabilityProfile(provider, getConfiguredModel(provider));
    if (!profile.knownModel) {
      warnings.push(`${provider}: Modell ${profile.model || '(leer)'} ist nicht in der Capability-Registry verifiziert.`);
    }
  }
  if (configuredProviders.includes('openrouter') && getConfiguredModel('openrouter') === 'openrouter/free') {
    warnings.push('OpenRouter openrouter/free ist ein niedrig limitierter Fallback und keine alleinige Hochlast-Konfiguration.');
  }

  return {
    primary,
    primaryConfigured: configuredProviders.includes(primary),
    configuredProviders,
    fallbackProviders: configuredProviders.filter(provider => provider !== primary),
    configuredCount: configuredProviders.length,
    resilience: configuredProviders.length === 0
      ? 'unavailable'
      : configuredProviders.length === 1
        ? 'single_provider'
        : 'redundant',
    warnings,
  };
}

interface CooldownState {
  until: number;
  consecutive: number;
  reason: string;
}

const cooldowns = new Map<ProviderName, CooldownState>();
const pendingCooldownWrites = new Map<ProviderName, number>();
const COOLDOWN_BASE_MS = 30_000;
const COOLDOWN_MAX_MS = 300_000;
const RETRY_AFTER_MAX_MS = 24 * 60 * 60_000;
const UNAVAILABLE_COOLDOWN_MS = 15 * 60_000;

function beginCooldownWrite(provider: ProviderName): void {
  pendingCooldownWrites.set(provider, (pendingCooldownWrites.get(provider) ?? 0) + 1);
}

function endCooldownWrite(provider: ProviderName): void {
  const remaining = (pendingCooldownWrites.get(provider) ?? 1) - 1;
  if (remaining > 0) pendingCooldownWrites.set(provider, remaining);
  else pendingCooldownWrites.delete(provider);
}

function hasPendingCooldownWrite(provider: ProviderName): boolean {
  return (pendingCooldownWrites.get(provider) ?? 0) > 0;
}

function getActiveCooldown(provider: ProviderName, now = Date.now()): CooldownState | null {
  const state = cooldowns.get(provider);
  if (!state) return null;
  if (now >= state.until) {
    // Ablauf erlaubt einen neuen Versuch, beweist aber noch keine Erholung.
    // Den 429-Streak bis Erfolg/explicit clear behalten, sonst startet jeder
    // erneute Fehler nach Ablauf wieder mit nur 30 Sekunden Backoff.
    if (state.reason !== '429_rate_limit') cooldowns.delete(provider);
    return null;
  }
  return state;
}

export async function hydrateCooldownsFromDb(): Promise<void> {
  try {
    const now = Date.now();
    const rows = await prisma.aiProviderStat.findMany({
      where: { cooldownUntil: { not: null } },
      select: {
        provider: true,
        cooldownUntil: true,
        cooldownStreak: true,
        cooldownReason: true,
      },
    });
    const seen = new Set<ProviderName>();
    const expiredProviders: ProviderName[] = [];
    for (const r of rows) {
      if (!ALL_PROVIDERS.includes(r.provider as ProviderName)) continue;
      if (!r.cooldownUntil) continue;
      const provider = r.provider as ProviderName;
      seen.add(provider);
      // Ein lokales Call-Ergebnis ist neuer als dieser gerade gelesene
      // Snapshot. Bis sein atomarer DB-Upsert beendet ist, darf der Sync weder
      // einen alten Cooldown reaktivieren noch einen neuen lokal loeschen.
      if (hasPendingCooldownWrite(provider)) continue;
      const until = r.cooldownUntil.getTime();
      // Auch abgelaufene 429-Zeilen behalten: ihr Timer sperrt nicht mehr,
      // ihr Streak muss aber einen Restart und den periodischen Sync ueberleben.
      if (now >= until && r.cooldownReason !== '429_rate_limit') {
        expiredProviders.push(provider);
        cooldowns.delete(provider);
        continue;
      }
      cooldowns.set(provider, {
        until,
        consecutive: r.cooldownStreak ?? 1,
        reason: r.cooldownReason || 'provider_unavailable',
      });
    }
    for (const [p] of cooldowns) {
      // Fehlt ein Provider im DB-Snapshot, wurde sein Circuit ggf. von einer
      // anderen Bot-Instanz nach Erfolg geloescht. Die DB ist nach Abschluss
      // lokaler Writes die kanonische Quelle, auch wenn der lokale Timer noch
      // nicht abgelaufen ist.
      if (!seen.has(p) && !hasPendingCooldownWrite(p)) cooldowns.delete(p);
    }
    if (expiredProviders.length > 0) {
      await prisma.aiProviderStat.updateMany({
        where: {
          provider: { in: expiredProviders },
          cooldownUntil: { lte: new Date(now) },
        },
        data: { cooldownUntil: null, cooldownReason: null, cooldownStreak: 0 },
      });
    }
  } catch (e) {
    logger.warn(`providerStats.hydrateCooldownsFromDb: ${(e as Error).message}`);
  }
}

let syncTimer: NodeJS.Timeout | null = null;
let syncStart: Promise<void> | null = null;
let syncGeneration = 0;

export async function scheduleProviderCooldownSync(intervalMs = 60_000): Promise<void> {
  if (syncTimer) return;
  if (syncStart) return syncStart;

  const generation = syncGeneration;
  const start = (async () => {
    await hydrateCooldownsFromDb();
    // stopProviderCooldownSync kann waehrend der initialen DB-Abfrage laufen.
    // Danach darf kein verwaister Timer mehr neu entstehen.
    if (generation !== syncGeneration || syncTimer) return;
    syncTimer = setInterval(() => { void hydrateCooldownsFromDb(); }, intervalMs);
    syncTimer.unref?.();
  })();
  syncStart = start;
  try {
    await start;
  } finally {
    if (syncStart === start) syncStart = null;
  }
}

export function stopProviderCooldownSync(): void {
  syncGeneration += 1;
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = null;
}

function applyRateLimitedCooldown(provider: ProviderName, retryAfterMs?: number): CooldownState & { durationMs: number } {
  const prev = cooldowns.get(provider);
  const previousRateLimitStreak = prev?.reason === '429_rate_limit' ? prev.consecutive : 0;
  const consecutive = previousRateLimitStreak + 1;
  const backoff = Math.min(COOLDOWN_BASE_MS * Math.pow(2, consecutive - 1), COOLDOWN_MAX_MS);
  const ms = retryAfterMs && retryAfterMs > 0
    ? Math.min(Math.max(retryAfterMs, 1_000), RETRY_AFTER_MAX_MS)
    : backoff;
  const until = Date.now() + ms;
  const state = { until, consecutive, reason: '429_rate_limit' };
  cooldowns.set(provider, state);
  logger.info(`providerStats: ${provider} cooldown ${Math.round(ms / 1000)}s (${consecutive}x 429 in Folge)`);
  return { ...state, durationMs: ms };
}

export function markRateLimited(provider: ProviderName, retryAfterMs?: number): number {
  const state = applyRateLimitedCooldown(provider, retryAfterMs);
  persistCooldown(provider, state.until, state.reason, state.consecutive);
  return state.durationMs;
}

export function markProviderUnavailable(provider: ProviderName, reason: string): void {
  const until = Date.now() + UNAVAILABLE_COOLDOWN_MS;
  const prev = getActiveCooldown(provider);
  const previousUnavailableStreak = prev?.reason !== '429_rate_limit' ? prev?.consecutive ?? 0 : 0;
  const consecutive = previousUnavailableStreak + 1;
  cooldowns.set(provider, { until, consecutive, reason });
  logger.warn(`providerStats: ${provider} ${Math.round(UNAVAILABLE_COOLDOWN_MS / 60000)}min aus Rotation (${reason} — Key/Model pruefen)`);
  persistCooldown(provider, until, reason, consecutive);
}

function persistCooldown(provider: ProviderName, until: number, reason: string, streak: number): void {
  beginCooldownWrite(provider);
  void prisma.aiProviderStat.upsert({
    where: { provider },
    update: { cooldownUntil: new Date(until), cooldownReason: reason, cooldownStreak: streak },
    create: { provider, cooldownUntil: new Date(until), cooldownReason: reason, cooldownStreak: streak },
  }).catch((e: unknown) => {
    logger.warn(`providerStats.persistCooldown fehlgeschlagen: ${String(e)}`);
  }).finally(() => endCooldownWrite(provider));
}

function clearCooldownInMemory(provider: ProviderName): void {
  cooldowns.delete(provider);
}

export function clearCooldown(provider: ProviderName): void {
  clearCooldownInMemory(provider);
  beginCooldownWrite(provider);
  void prisma.aiProviderStat.updateMany({
    where: { provider, cooldownUntil: { not: null } },
    data: { cooldownUntil: null, cooldownReason: null, cooldownStreak: 0 },
  }).catch(() => { /* ignore */ })
    .finally(() => endCooldownWrite(provider));
}

export function isOnCooldown(provider: ProviderName): boolean {
  return getActiveCooldown(provider) !== null;
}

export function getCooldownRemainingMs(provider: ProviderName): number {
  const c = getActiveCooldown(provider);
  return c ? c.until - Date.now() : 0;
}

/**
 * Dieses Signal wird vom Zero-Provider-Fallback in callAI verwendet. Es darf
 * nur dann 429-Cooldowns liefern, wenn unter den AKTIVEN Circuits der
 * konfigurierten Provider kein harter Provider-/Billing-/Modell-Circuit liegt.
 * Sonst waere eine gemischte Lage wie Cerebras 402 + OpenRouter 404 +
 * Groq/Gemini 429 beim Folgerequest faelschlich wieder ein globales RATE_LIMIT.
 *
 * Die vollstaendige Circuit-Diagnostik bleibt unabhaengig davon ueber
 * getStats() erhalten (cooldownReason/cooldownRemainingMs/cooldownStreak).
 */
export function getAllCooldowns(): Array<{ provider: ProviderName; remainingMs: number; consecutive: number }> {
  const now = Date.now();
  const activeConfigured: Array<{ provider: ProviderName; state: CooldownState }> = [];

  for (const provider of ALL_PROVIDERS) {
    if (!isConfigured(provider)) continue;
    const state = getActiveCooldown(provider, now);
    if (state) activeConfigured.push({ provider, state });
  }

  // Fail-closed fuer die globale Klassifikation: Sobald ein konfigurierter
  // Provider aus einem anderen Grund als 429 im Circuit ist, ist die Gesamtlage
  // gemischt und darf nicht als "alle Provider rate-limited" erscheinen.
  if (activeConfigured.some(({ state }) => state.reason !== '429_rate_limit')) return [];

  return activeConfigured
    .filter(({ state }) => state.reason === '429_rate_limit')
    .map(({ provider, state }) => ({
      provider,
      remainingMs: state.until - now,
      consecutive: state.consecutive,
    }));
}

export async function recordCall(
  provider: ProviderName,
  outcome: 'success' | 'failure' | 'rateLimit',
  latencyMs: number,
  error?: string,
  opts?: { retryAfterMs?: number },
): Promise<void> {
  // AI-20: recordCall ist bereits die kanonische Stelle fuer abgeschlossene
  // Provider-Call-Ergebnisse. Observability wird hier synchron und best-effort
  // gespiegelt, bevor persistente Statistik geschrieben wird. Keine Prompts,
  // User/Guild-IDs oder Fehlermeldungen gelangen in Metrik-Labels.
  try {
    const observedOutcome = outcome === 'rateLimit' ? 'rate_limit' : outcome;
    recordAiProviderAttempt({
      provider,
      model: getConfiguredModel(provider),
      outcome: observedOutcome,
      latencyMs,
    });
    if (outcome !== 'success') {
      recordAiFallback({
        fromProvider: provider,
        reason: outcome === 'rateLimit' ? 'rate_limit' : 'failure',
      });
    }
  } catch (e) {
    logger.warn(`providerStats.recordCall observability fehlgeschlagen: ${String(e)}`);
  }

  let rateLimitState: (CooldownState & { durationMs: number }) | null = null;
  if (outcome === 'success') clearCooldownInMemory(provider);
  if (outcome === 'rateLimit') rateLimitState = applyRateLimitedCooldown(provider, opts?.retryAfterMs);
  const writesCooldown = outcome === 'success' || outcome === 'rateLimit';
  if (writesCooldown) beginCooldownWrite(provider);
  try {
    const now = new Date();
    const data: Record<string, unknown> = {};
    if (outcome === 'success') {
      data.successCount = { increment: 1 };
      data.totalLatencyMs = { increment: BigInt(Math.max(0, Math.round(latencyMs))) };
      data.lastSuccessAt = now;
      data.cooldownUntil = null;
      data.cooldownReason = null;
      data.cooldownStreak = 0;
    } else if (outcome === 'rateLimit') {
      data.rateLimitCount = { increment: 1 };
      data.lastFailureAt = now;
      data.lastError = (error || '429 Rate Limit').slice(0, 500);
      data.cooldownUntil = new Date(rateLimitState!.until);
      data.cooldownReason = '429_rate_limit';
      data.cooldownStreak = rateLimitState!.consecutive;
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
        cooldownUntil: outcome === 'rateLimit' ? new Date(rateLimitState!.until) : null,
        cooldownReason: outcome === 'rateLimit' ? '429_rate_limit' : null,
        cooldownStreak: outcome === 'rateLimit' ? rateLimitState!.consecutive : 0,
      },
    });
  } catch (e) {
    logger.warn(`providerStats.recordCall fehlgeschlagen: ${String(e)}`);
  } finally {
    if (writesCooldown) endCooldownWrite(provider);
  }
}

export async function getStats(): Promise<ProviderStat[]> {
  const rows = await prisma.aiProviderStat.findMany();
  const map = new Map<string, typeof rows[number]>();
  for (const r of rows) map.set(r.provider, r);
  const now = Date.now();
  return ALL_PROVIDERS.map((p) => {
    const r = map.get(p);
    const success = r?.successCount ?? 0;
    const fail = r?.failureCount ?? 0;
    const rate = r?.rateLimitCount ?? 0;
    const total = success + fail + rate;
    const totalLatency = r ? Number(r.totalLatencyMs) : 0;
    const circuit = getActiveCooldown(p, now);
    const model = getConfiguredModel(p);
    const capability = getProviderCapabilityProfile(p, model);
    return {
      provider: p,
      model,
      knownModel: capability.knownModel,
      capabilities: [...capability.capabilities],
      successCount: success,
      failureCount: fail,
      rateLimitCount: rate,
      avgLatencyMs: success > 0 ? Math.round(totalLatency / success) : 0,
      successRate: total > 0 ? success / total : 0,
      lastSuccessAt: r?.lastSuccessAt ?? null,
      lastFailureAt: r?.lastFailureAt ?? null,
      lastError: r?.lastError ?? null,
      configured: isConfigured(p),
      cooldownReason: circuit?.reason ?? null,
      cooldownRemainingMs: circuit ? Math.max(0, circuit.until - now) : 0,
      cooldownStreak: circuit?.consecutive ?? 0,
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

function extractGeminiReply(data: unknown): string {
  const candidate = (data as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: unknown; thought?: unknown }> } }>;
  })?.candidates?.[0];
  const parts = candidate?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts
    .filter(part => part?.thought !== true && typeof part?.text === 'string')
    .map(part => String(part.text).trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

export async function probeProvider(provider: ProviderName): Promise<{
  ok: boolean;
  latencyMs: number;
  error?: string;
  reply?: string;
  classification?: ProviderFailureKind;
  httpStatus?: number;
  providerCode?: string;
  retryAfterMs?: number;
  requestIdHash?: string;
}> {
  if (!isConfigured(provider)) {
    return { ok: false, latencyMs: 0, error: 'Kein API-Key konfiguriert' };
  }
  const t0 = Date.now();
  try {
    let reply = '';
    if (provider === 'gemini') {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.ai.geminiModel}:generateContent`;
      const rawBody = {
        contents: [{ role: 'user', parts: [{ text: 'Antworte nur mit: pong' }] }],
        generationConfig: { maxOutputTokens: 128 },
      };
      const body = normalizeAiProviderRequest(url, rawBody);
      const res = await axios.post(
        url,
        body,
        { headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.ai.geminiApiKey }, timeout: 10000 },
      );
      reply = extractGeminiReply(res.data);
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
      const url = `${c.url}/chat/completions`;
      const rawBody = {
        model: c.model,
        messages: [{ role: 'user', content: 'Antworte nur mit: pong' }],
        max_completion_tokens: 128,
      };
      const body = normalizeAiProviderRequest(url, rawBody);
      const res = await axios.post(
        url,
        body,
        {
          headers: { Authorization: `Bearer ${c.key}`, 'Content-Type': 'application/json' },
          timeout: 10000,
        },
      );
      reply = String(res.data?.choices?.[0]?.message?.content ?? '').trim();
    }
    const latency = Date.now() - t0;
    if (!reply) {
      return { ok: false, latencyMs: latency, error: 'Provider lieferte eine leere Textantwort' };
    }
    return { ok: true, latencyMs: latency, reply: reply.slice(0, 80) };
  } catch (e) {
    const latency = Date.now() - t0;
    const classification = classifyProviderError(e);
    return {
      ok: false,
      latencyMs: latency,
      error: safeProviderFailureLabel(classification, e),
      classification: classification.kind,
      ...(classification.status ? { httpStatus: classification.status } : {}),
      ...(classification.providerCode ? { providerCode: classification.providerCode } : {}),
      ...(classification.retryAfterMs > 0 ? { retryAfterMs: classification.retryAfterMs } : {}),
      ...(classification.requestIdHash ? { requestIdHash: classification.requestIdHash } : {}),
    };
  }
}
