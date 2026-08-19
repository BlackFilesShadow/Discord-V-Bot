/** Schmaler Dashboard-API-Client mit Cookie-Session + Idempotency-Key. */
export class ApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly code: string | null = null, public readonly body: unknown = null) { super(message); }
}

function extractError(data: unknown, status: number): { msg: string; code: string | null } {
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    return { msg: typeof obj.error === 'string' ? obj.error : `HTTP ${status}`, code: typeof obj.code === 'string' ? obj.code : null };
  }
  return { msg: `HTTP ${status}`, code: null };
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
  const result = await decode<T>(await fetch(scopedPath, { method, headers, body: payload, credentials: 'include' }));
  if (lease) releaseMutationIdempotencyKey(lease);
  return result;
}

async function formRequest<T>(method: 'POST' | 'PUT' | 'PATCH', path: string, fd: FormData): Promise<T> {
  // FormData/Uploads haben keinen stabilen serialisierten Payload-Fingerprint und
  // bleiben deshalb bewusst bei einem frischen Key pro Aufruf.
  const headers: Record<string, string> = { Accept: 'application/json', 'X-Idempotency-Key': createIdempotencyKey() };
  return decode<T>(await fetch(withServerSlotScope(path), { method, headers, body: fd, credentials: 'include' }));
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
