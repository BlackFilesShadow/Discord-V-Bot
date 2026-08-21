/** Schmaler Dashboard-API-Client mit Cookie-Session + Idempotency-Key. */

/** Stage 29: transport vs HTTP taxonomy for fail-closed UI rendering. */
export type ApiErrorKind = 'http' | 'offline' | 'timeout' | 'network' | 'abort';

export class ApiError extends Error {
  readonly kind: ApiErrorKind;

  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string | null = null,
    public readonly body: unknown = null,
    kind: ApiErrorKind = 'http',
  ) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
  }

  /** True when a safe manual retry may be offered (never auto-mask as success). */
  get retryable(): boolean {
    if (this.kind === 'timeout' || this.kind === 'network' || this.kind === 'offline') return true;
    if (this.status === 429 || this.status >= 500) return true;
    return false;
  }
}

/** Default per-request budget; long exports/uploads should use dedicated clients. */
export const API_REQUEST_TIMEOUT_MS = 30_000;

function extractError(data: unknown, status: number): { msg: string; code: string | null } {
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    return { msg: typeof obj.error === 'string' ? obj.error : `HTTP ${status}`, code: typeof obj.code === 'string' ? obj.code : null };
  }
  return { msg: `HTTP ${status}`, code: null };
}

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const name = String((err as { name?: unknown }).name ?? '');
  return name === 'AbortError' || name === 'TimeoutError';
}

/**
 * Maps browser/network failures to structured ApiError codes so UI never treats
 * transport loss as a silent success or generic untyped throw.
 */
export function classifyTransportError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return new ApiError('Keine Netzwerkverbindung (offline).', 0, 'NETWORK_OFFLINE', null, 'offline');
  }
  if (isAbortError(err)) {
    return new ApiError('Anfrage abgebrochen oder Zeitueberschreitung.', 0, 'REQUEST_TIMEOUT', null, 'timeout');
  }
  const msg = err instanceof Error ? err.message : String(err ?? 'network error');
  const lower = msg.toLowerCase();
  if (lower.includes('failed to fetch') || lower.includes('networkerror') || lower.includes('load failed') || lower.includes('econnreset')) {
    return new ApiError('Netzwerkfehler — Verbindung unterbrochen.', 0, 'NETWORK_ERROR', null, 'network');
  }
  return new ApiError(msg || 'Netzwerkfehler.', 0, 'NETWORK_ERROR', null, 'network');
}

/** Stable UI copy for toasts/inline alerts without inventing success. */
export function describeApiError(err: unknown): {
  title: string;
  desc: string;
  status: number;
  code: string | null;
  kind: ApiErrorKind | 'unknown';
  retryable: boolean;
} {
  if (err instanceof ApiError) {
    if (err.kind === 'offline') {
      return { title: 'Offline', desc: err.message, status: 0, code: err.code, kind: err.kind, retryable: true };
    }
    if (err.kind === 'timeout') {
      return { title: 'Zeitueberschreitung', desc: err.message, status: 0, code: err.code, kind: err.kind, retryable: true };
    }
    if (err.kind === 'network') {
      return { title: 'Netzwerkfehler', desc: err.message, status: 0, code: err.code, kind: err.kind, retryable: true };
    }
    if (err.status === 401) {
      return { title: 'Nicht angemeldet', desc: err.message, status: 401, code: err.code, kind: 'http', retryable: false };
    }
    if (err.status === 403) {
      return { title: 'Keine Berechtigung', desc: err.message, status: 403, code: err.code, kind: 'http', retryable: false };
    }
    if (err.status === 404) {
      return { title: 'Nicht gefunden', desc: err.message, status: 404, code: err.code, kind: 'http', retryable: false };
    }
    if (err.status === 409) {
      return { title: 'Konflikt', desc: err.message, status: 409, code: err.code, kind: 'http', retryable: false };
    }
    if (err.status === 429) {
      return { title: 'Zu viele Anfragen', desc: err.message, status: 429, code: err.code, kind: 'http', retryable: true };
    }
    if (err.status >= 500) {
      return { title: 'Serverfehler', desc: err.message, status: err.status, code: err.code, kind: 'http', retryable: true };
    }
    if (err.status === 400) {
      return { title: 'Ungueltige Anfrage', desc: err.message, status: 400, code: err.code, kind: 'http', retryable: false };
    }
    return { title: 'Fehler', desc: err.message, status: err.status, code: err.code, kind: err.kind, retryable: err.retryable };
  }
  const message = err instanceof Error ? err.message : 'Unbekannter Fehler';
  return { title: 'Fehler', desc: message, status: 0, code: null, kind: 'unknown', retryable: false };
}

export function createIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

const PENDING_IDEMPOTENCY_PREFIX = 'vbot:pending-idempotency:';
const pendingMutationKeys = new Map<string, string>();
const pendingMutationKeyLoads = new Map<string, Promise<MutationIdempotencyLease>>();

interface MutationIdempotencyLease {
  signature: string;
  key: string;
  storageKey: string | null;
}

function sessionStorageSafe(): Storage | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.sessionStorage ?? null;
  } catch {
    return null;
  }
}

async function mutationStorageKey(signature: string): Promise<string | null> {
  try {
    if (typeof crypto === 'undefined' || !crypto.subtle) return null;
    const bytes = new TextEncoder().encode(signature);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const hex = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    return `${PENDING_IDEMPOTENCY_PREFIX}${hex}`;
  } catch {
    return null;
  }
}

function validStoredIdempotencyKey(value: string | null): value is string {
  return value !== null && value.trim().length >= 8 && value.trim().length <= 128;
}

/**
 * Ein logisch identischer, noch nicht bestaetigter JSON-Mutationsrequest behält
 * denselben Idempotency-Key. Der Request-Inhalt selbst wird niemals persistiert:
 * sessionStorage sieht nur einen SHA-256-Fingerprint und den zufaelligen Key.
 */
async function acquireMutationIdempotencyKey(signature: string): Promise<MutationIdempotencyLease> {
  const memoryKey = pendingMutationKeys.get(signature);
  if (memoryKey) {
    return { signature, key: memoryKey, storageKey: await mutationStorageKey(signature) };
  }

  const loading = pendingMutationKeyLoads.get(signature);
  if (loading) return loading;

  const promise = (async (): Promise<MutationIdempotencyLease> => {
    const storageKey = await mutationStorageKey(signature);
    const storage = sessionStorageSafe();
    let stored: string | null = null;
    if (storageKey && storage) {
      try { stored = storage.getItem(storageKey); } catch { /* storage optional */ }
    }
    const key = validStoredIdempotencyKey(stored) ? stored.trim() : createIdempotencyKey();
    pendingMutationKeys.set(signature, key);
    if (storageKey && storage && stored !== key) {
      try { storage.setItem(storageKey, key); } catch { /* storage optional */ }
    }
    return { signature, key, storageKey };
  })();

  pendingMutationKeyLoads.set(signature, promise);
  try {
    return await promise;
  } finally {
    pendingMutationKeyLoads.delete(signature);
  }
}

function releaseMutationIdempotencyKey(lease: MutationIdempotencyLease): void {
  if (pendingMutationKeys.get(lease.signature) === lease.key) {
    pendingMutationKeys.delete(lease.signature);
  }
  const storage = sessionStorageSafe();
  if (!lease.storageKey || !storage) return;
  try {
    if (storage.getItem(lease.storageKey) === lease.key) storage.removeItem(lease.storageKey);
  } catch { /* storage optional */ }
}

/**
 * ServerSlot ist bereits ein expliziter Gameserver-Kontext. Economy/Casino
 * duerfen diesen Kontext nicht verlieren und bei Multi-Server-Guilds spaeter
 * serverweit geraten. Darum traegt der zentrale Client fuer genau diese APIs
 * den sichtbaren Slot als Query-Parameter mit, sofern der Aufrufer nicht schon
 * selbst `slot` oder `nitradoConnId` gesetzt hat.
 */
function withServerSlotScope(path: string): string {
  if (typeof window === 'undefined') return path;
  const route = /^\/servers\/([^/]+)\/server\/(\d+)(?:\/|$)/.exec(window.location.pathname);
  if (!route) return path;

  const [, guildId, slot] = route;
  if (!/^\d{17,20}$/.test(guildId) || !/^[1-5]$/.test(slot)) return path;

  let url: URL;
  try { url = new URL(path, window.location.origin); }
  catch { return path; }

  const economyPrefix = `/api/v2/guilds/${guildId}/economy`;
  const casinoPrefix = `/api/v2/guilds/${guildId}/casino`;
  if (!(url.pathname === economyPrefix || url.pathname.startsWith(`${economyPrefix}/`) ||
        url.pathname === casinoPrefix || url.pathname.startsWith(`${casinoPrefix}/`))) {
    return path;
  }
  if (!url.searchParams.has('slot') && !url.searchParams.has('nitradoConnId')) {
    url.searchParams.set('slot', slot);
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

async function decode<T>(res: Response): Promise<T> {
  const text = await res.text();
  let data: unknown = null;
  if (text) { try { data = JSON.parse(text); } catch { data = text; } }
  if (!res.ok) { const { msg, code } = extractError(data, res.status); throw new ApiError(msg, res.status, code, data); }
  return data as T;
}

async function fetchWithTimeout(path: string, init: RequestInit, timeoutMs = API_REQUEST_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const external = init.signal;
  const onExternalAbort = (): void => controller.abort();
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener('abort', onExternalAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(path, { ...init, signal: controller.signal });
  } catch (err) {
    throw classifyTransportError(err);
  } finally {
    clearTimeout(timer);
    if (external) external.removeEventListener('abort', onExternalAbort);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  let payload: BodyInit | undefined;
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const scopedPath = withServerSlotScope(path);
  let lease: MutationIdempotencyLease | null = null;
  if (method !== 'GET') {
    const signature = `${method}\n${scopedPath}\n${typeof payload === 'string' ? payload : ''}`;
    lease = await acquireMutationIdempotencyKey(signature);
    headers['X-Idempotency-Key'] = lease.key;
  }

  // Nur ein bestaetigter 2xx-Decode gibt den Pending-Key frei. Bei Netzfehler,
  // 409 oder unbekanntem Serverergebnis bleibt derselbe Key fuer den Retry erhalten.
  const result = await decode<T>(await fetchWithTimeout(scopedPath, { method, headers, body: payload, credentials: 'include' }));
  if (lease) releaseMutationIdempotencyKey(lease);
  return result;
}

async function formRequest<T>(method: 'POST' | 'PUT' | 'PATCH', path: string, fd: FormData): Promise<T> {
  // FormData/Uploads haben keinen stabilen serialisierten Payload-Fingerprint und
  // bleiben deshalb bewusst bei einem frischen Key pro Aufruf.
  const headers: Record<string, string> = { Accept: 'application/json', 'X-Idempotency-Key': createIdempotencyKey() };
  return decode<T>(await fetchWithTimeout(withServerSlotScope(path), { method, headers, body: fd, credentials: 'include' }));
}

async function uploadRequest<T>(path: string, file: File, fieldName = 'file'): Promise<T> {
  const fd = new FormData();
  fd.append(fieldName, file);
  return formRequest<T>('POST', path, fd);
}

export const api = {
  get: <T,>(p: string) => request<T>('GET', p),
  post: <T,>(p: string, b?: unknown) => request<T>('POST', p, b),
  put: <T,>(p: string, b?: unknown) => request<T>('PUT', p, b),
  patch: <T,>(p: string, b?: unknown) => request<T>('PATCH', p, b),
  del: <T,>(p: string, b?: unknown) => request<T>('DELETE', p, b),
  upload: <T,>(p: string, file: File, fieldName?: string) => uploadRequest<T>(p, file, fieldName),
  uploadForm: <T,>(p: string, fd: FormData) => formRequest<T>('POST', p, fd),
  form: <T,>(method: 'POST' | 'PUT' | 'PATCH', p: string, fd: FormData) => formRequest<T>(method, p, fd),
};
