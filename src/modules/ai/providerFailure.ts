import { createHash } from 'node:crypto';

export interface ProviderFailureClassification {
  isRateLimit: boolean;
  isAuthOrModel: boolean;
}

export type ProviderFailureKind =
  | 'rate_limit'
  | 'quota_or_billing'
  | 'auth_or_model'
  | 'transient'
  | 'unknown';

export interface ProviderErrorClassification extends ProviderFailureClassification {
  kind: ProviderFailureKind;
  status?: number;
  providerCode?: string;
  circuitReason?: string;
  retryAfterMs: number;
  requestIdHash?: string;
}

type ErrorResponse = {
  status?: unknown;
  headers?: unknown;
  data?: unknown;
};

type ProviderErrorLike = {
  code?: unknown;
  message?: unknown;
  response?: ErrorResponse;
};

const HARD_QUOTA_CODES = new Set([
  'billing_hard_limit_reached',
  'billing_not_active',
  'credit_balance_exhausted',
  'credits_exhausted',
  'insufficient_credits',
  'insufficient_quota',
  'organization_spend_limit_exceeded',
  'organization_usage_limit_exceeded',
  'payment_required',
  'project_spend_limit_exceeded',
  'spending_limit_reached',
  'usage_limit_reached',
]);

const HARD_MODEL_CODES = new Set([
  'access_denied',
  'authentication_error',
  'invalid_api_key',
  'invalid_model',
  'model_decommissioned',
  'model_not_found',
  'permission_denied',
  'unsupported_model',
  'unsupported_parameter',
]);

const KNOWN_PROVIDER_CODES = new Set([
  ...HARD_QUOTA_CODES,
  ...HARD_MODEL_CODES,
  'bad_request',
  'internal_error',
  'internal_server_error',
  'invalid_request_error',
  'not_found',
  'overloaded_error',
  'quota_exceeded',
  'rate_limit_error',
  'rate_limit_exceeded',
  'resource_exhausted',
  'server_error',
  'service_unavailable',
  'too_many_requests',
  'unauthenticated',
]);

const NETWORK_CODES = new Set([
  'eai_again',
  'econnaborted',
  'econnrefused',
  'econnreset',
  'enotfound',
  'etimedout',
  'err_bad_request',
  'err_bad_response',
  'err_network',
]);

const MAX_RETRY_AFTER_MS = 24 * 60 * 60_000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object'
    ? value as Record<string, unknown>
    : null;
}

function safeToken(value: unknown, maxLength = 80): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const normalized = String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, maxLength);
  return normalized || undefined;
}

function responseData(error: unknown): Record<string, unknown> | null {
  return asRecord((error as ProviderErrorLike)?.response?.data);
}

function extractProviderCodes(error: unknown): string[] {
  const data = responseData(error);
  const nested = asRecord(data?.error);
  const candidates = [
    nested?.code,
    nested?.type,
    nested?.status,
    data?.code,
    data?.type,
    data?.status,
  ];
  return [...new Set(candidates
    .map(candidate => safeToken(candidate))
    .filter((token): token is string => Boolean(token && KNOWN_PROVIDER_CODES.has(token))))];
}

function extractProviderMessage(error: unknown): string {
  const data = responseData(error);
  const nested = asRecord(data?.error);
  const candidate = nested?.message ?? data?.message;
  return typeof candidate === 'string' ? candidate.toLowerCase().slice(0, 500) : '';
}

function readHeader(headers: unknown, name: string): string | undefined {
  const headerBag = headers as { get?: (key: string) => unknown } | null | undefined;
  if (typeof headerBag?.get === 'function') {
    const value = headerBag.get(name);
    if (value !== undefined && value !== null) return String(value).trim();
  }
  const record = asRecord(headers);
  if (!record) return undefined;
  const matchingKey = Object.keys(record).find(key => key.toLowerCase() === name.toLowerCase());
  const value = matchingKey ? record[matchingKey] : undefined;
  if (Array.isArray(value)) return value.length > 0 ? String(value[0]).trim() : undefined;
  return value !== undefined && value !== null ? String(value).trim() : undefined;
}

function parseDuration(value: string): number {
  const raw = value.trim().toLowerCase();
  if (!raw) return 0;
  if (/^\d+(?:\.\d+)?ms$/.test(raw)) return Math.round(Number(raw.slice(0, -2)));
  if (/^\d+(?:\.\d+)?s$/.test(raw)) return Math.round(Number(raw.slice(0, -1)) * 1000);

  const duration = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?$/.exec(raw);
  if (!duration || !duration.slice(1).some(Boolean)) return 0;
  return Math.round(
    Number(duration[1] || 0) * 3_600_000
    + Number(duration[2] || 0) * 60_000
    + Number(duration[3] || 0) * 1000,
  );
}

function boundedRetryDelay(value: number): number {
  return Number.isFinite(value) && value > 0
    ? Math.min(MAX_RETRY_AFTER_MS, Math.round(value))
    : 0;
}

/** Liest nur allowlistete Recovery-Header, niemals Prompt oder Authorization. */
export function parseProviderRetryAfterMs(error: unknown, now = Date.now()): number {
  const headers = (error as ProviderErrorLike)?.response?.headers;
  const retryAfterMs = readHeader(headers, 'retry-after-ms');
  if (retryAfterMs && /^\d+(?:\.\d+)?$/.test(retryAfterMs)) {
    return boundedRetryDelay(Number(retryAfterMs));
  }

  const retryAfter = readHeader(headers, 'retry-after');
  if (retryAfter) {
    if (/^\d+(?:\.\d+)?$/.test(retryAfter)) {
      return boundedRetryDelay(Number(retryAfter) * 1000);
    }
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) return boundedRetryDelay(date - now);
  }

  const resetHeaders = [
    ['x-ratelimit-reset-requests', 'x-ratelimit-remaining-requests'],
    ['x-ratelimit-reset-tokens', 'x-ratelimit-remaining-tokens'],
    ['x-ratelimit-reset-project-tokens', 'x-ratelimit-remaining-project-tokens'],
    ['x-ratelimit-reset-input-tokens', 'x-ratelimit-remaining-input-tokens'],
    ['x-ratelimit-reset-output-tokens', 'x-ratelimit-remaining-output-tokens'],
    ['x-ratelimit-reset', 'x-ratelimit-remaining'],
  ];
  const candidates: Array<{ delayMs: number; remaining: number | null }> = [];
  for (const [header, remainingHeader] of resetHeaders) {
    const raw = readHeader(headers, header);
    if (!raw) continue;
    let delayMs = boundedRetryDelay(parseDuration(raw));
    if (delayMs === 0 && /^\d+(?:\.\d+)?$/.test(raw)) {
      const numeric = Number(raw);
      const asMs = numeric > 10_000_000_000
        ? numeric - now
        : numeric > 1_000_000_000
          ? numeric * 1000 - now
          : numeric * 1000;
      delayMs = boundedRetryDelay(asMs);
    }
    if (delayMs === 0) continue;
    const remainingRaw = readHeader(headers, remainingHeader);
    const remaining = remainingRaw !== undefined && /^-?\d+(?:\.\d+)?$/.test(remainingRaw)
      && Number.isFinite(Number(remainingRaw))
      ? Number(remainingRaw)
      : null;
    candidates.push({ delayMs, remaining });
  }
  // Requests und Tokens sind unabhaengige Limits. Ein schneller Request-Reset
  // darf einen noch erschoepften Token-Bucket nicht umgehen. Ohne eindeutige
  // Remaining-Metadaten bleiben wir konservativ bei der laengsten Wartezeit.
  const exhaustedOrUnknown = candidates.filter(item => item.remaining === null || item.remaining <= 0);
  const relevant = exhaustedOrUnknown.length > 0 ? exhaustedOrUnknown : candidates;
  return relevant.length > 0 ? Math.max(...relevant.map(item => item.delayMs)) : 0;
}

function extractRequestIdHash(error: unknown): string | undefined {
  const headers = (error as ProviderErrorLike)?.response?.headers;
  for (const name of ['x-request-id', 'request-id', 'x-goog-request-id']) {
    const value = readHeader(headers, name);
    if (!value) continue;
    // IDs erlauben Log-Korrelation, duerfen aber keine vom Upstream beliebig
    // eingeschleusten Secrets als Klartext in Logs/Probe-JSON transportieren.
    return createHash('sha256').update(value).digest('hex').slice(0, 16);
  }
  return undefined;
}

/** Status-only Vertrag fuer bestehende Aufrufer. */
export function classifyProviderHttpStatus(status?: number): ProviderFailureClassification {
  return {
    isRateLimit: status === 429,
    isAuthOrModel: status === 401 || status === 402 || status === 403 || status === 404,
  };
}

/**
 * Payload-bewusste Klassifikation. Ein 429 mit insufficient_quota/credits ist
 * kein kurzer Burst und darf deshalb nicht als „in paar Minuten“ erscheinen.
 */
export function classifyProviderError(error: unknown): ProviderErrorClassification {
  const rawStatus = (error as ProviderErrorLike)?.response?.status;
  const status = typeof rawStatus === 'number' && Number.isFinite(rawStatus) ? rawStatus : undefined;
  const providerCodes = extractProviderCodes(error);
  const providerCode = providerCodes.find(code => HARD_QUOTA_CODES.has(code))
    ?? providerCodes.find(code => HARD_MODEL_CODES.has(code))
    ?? providerCodes[0];
  const providerMessage = extractProviderMessage(error);
  const hardQuota = status === 429 && (
    providerCodes.some(code => HARD_QUOTA_CODES.has(code))
    || /(?:insufficient|depleted|exhausted|out of) (?:api )?credits?|credit balance (?:exhausted|depleted)|billing (?:limit|inactive|required)/i.test(providerMessage)
  );
  const hardStatus = status === 401 || status === 402 || status === 403 || status === 404;
  const hardModel = (status === 400 || status === 422)
    && providerCodes.some(code => HARD_MODEL_CODES.has(code));
  const isAuthOrModel = hardQuota || hardStatus || hardModel;
  const isRateLimit = status === 429 && !hardQuota;
  const transient = status !== undefined && status >= 500;

  let kind: ProviderFailureKind = 'unknown';
  if (hardQuota || status === 402) kind = 'quota_or_billing';
  else if (isAuthOrModel) kind = 'auth_or_model';
  else if (isRateLimit) kind = 'rate_limit';
  else if (transient) kind = 'transient';

  return {
    kind,
    status,
    providerCode,
    isRateLimit,
    isAuthOrModel,
    circuitReason: isAuthOrModel
      ? (providerCode ? `provider_${providerCode}` : hardQuota ? 'provider_quota_or_billing' : `http_${status}`)
      : undefined,
    retryAfterMs: parseProviderRetryAfterMs(error),
    requestIdHash: extractRequestIdHash(error),
  };
}

/** Nur allowlistete Metadaten; niemals Provider-Body, Prompt oder API-Key. */
export function safeProviderFailureLabel(
  classification: ProviderErrorClassification,
  error?: unknown,
): string {
  if (classification.status) {
    return classification.providerCode
      ? `http_${classification.status}:${classification.providerCode}`
      : `http_${classification.status}`;
  }
  const networkCode = safeToken((error as ProviderErrorLike)?.code);
  return networkCode && NETWORK_CODES.has(networkCode) ? `network_${networkCode}` : 'provider_error';
}

/** Reine statusbasierte Kompatibilitaetsfunktion fuer bestehende Tests/Aufrufer. */
export function updateAllRateLimitedState(current: boolean, status?: number): boolean {
  return current && status === 429;
}
