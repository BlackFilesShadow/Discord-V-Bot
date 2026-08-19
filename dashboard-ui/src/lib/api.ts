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

const ADMIN_PAY_RETAINED_KEY_STORAGE = 'vbot:admin-pay-idempotency:v1';

interface RetainedAdminPayKey {
  fingerprint: string;
  key: string;
}

function isAdminPayMutation(method: string, scopedPath: string): boolean {
  if (method !== 'POST') return false;
  let pathname = scopedPath;
  try { pathname = new URL(scopedPath, 'https://dashboard.local').pathname; }
  catch { /* relative path fallback */ }
  return /^\/api\/v2\/guilds\/\d{17,20}\/economy\/accounts\/\d{17,20}\/admin-pay$/.test(pathname);
}

function readRetainedAdminPayKey(): RetainedAdminPayKey | null {
  if (typeof sessionStorage === 'undefined') return null;
  try {
    const raw = sessionStorage.getItem(ADMIN_PAY_RETAINED_KEY_STORAGE);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<RetainedAdminPayKey>;
    if (typeof parsed.fingerprint !== 'string' || typeof parsed.key !== 'string') return null;
    return { fingerprint: parsed.fingerprint, key: parsed.key };
  } catch { return null; }
}

function retainAdminPayKey(method: string, scopedPath: string, body: unknown): RetainedAdminPayKey {
  const fingerprint = `${method}:${scopedPath}:${JSON.stringify(body ?? null)}`;
  const existing = readRetainedAdminPayKey();
  if (existing?.fingerprint === fingerprint) return existing;

  const next = { fingerprint, key: createIdempotencyKey() };
  if (typeof sessionStorage !== 'undefined') {
    try { sessionStorage.setItem(ADMIN_PAY_RETAINED_KEY_STORAGE, JSON.stringify(next)); }
    catch { /* Private-/Storage-Mode: Request bleibt weiterhin einmalig idempotent. */ }
  }
  return next;
}

function clearRetainedAdminPayKey(retained: RetainedAdminPayKey): void {
  if (typeof sessionStorage === 'undefined') return;
  try {
    const current = readRetainedAdminPayKey();
    if (current?.fingerprint === retained.fingerprint && current.key === retained.key) {
      sessionStorage.removeItem(ADMIN_PAY_RETAINED_KEY_STORAGE);
    }
  } catch { /* best-effort client cleanup */ }
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
  let retainedAdminPay: RetainedAdminPayKey | null = null;
  if (method !== 'GET') {
    if (isAdminPayMutation(method, scopedPath)) {
      retainedAdminPay = retainAdminPayKey(method, scopedPath, body);
      headers['X-Idempotency-Key'] = retainedAdminPay.key;
    } else {
      headers['X-Idempotency-Key'] = createIdempotencyKey();
    }
  }

  const result = await decode<T>(await fetch(scopedPath, { method, headers, body: payload, credentials: 'include' }));
  if (retainedAdminPay) clearRetainedAdminPayKey(retainedAdminPay);
  return result;
}

async function formRequest<T>(method: 'POST' | 'PUT' | 'PATCH', path: string, fd: FormData): Promise<T> {
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
