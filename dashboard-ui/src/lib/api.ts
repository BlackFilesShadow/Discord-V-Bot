/**
 * Schmaler API-Client. Cookies via `credentials: 'include'`.
 * Mutations setzen `X-Idempotency-Key` (UUID), so dass das v2-Backend
 * Doppel-Klicks neutralisiert (Haertung A1).
 */

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string | null = null,
    public readonly body: unknown = null,
  ) {
    super(message);
  }
}

function extractError(data: unknown, status: number): { msg: string; code: string | null } {
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    const msg = typeof obj.error === 'string' ? obj.error : `HTTP ${status}`;
    const code = typeof obj.code === 'string' ? obj.code : null;
    return { msg, code };
  }
  return { msg: `HTTP ${status}`, code: null };
}

function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  let payload: BodyInit | undefined;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  if (method !== 'GET') headers['X-Idempotency-Key'] = uuid();

  const res = await fetch(path, { method, headers, body: payload, credentials: 'include' });
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  if (!res.ok) {
    const { msg, code } = extractError(data, res.status);
    throw new ApiError(msg, res.status, code, data);
  }
  return data as T;
}

async function uploadRequest<T>(path: string, file: File, fieldName = 'file'): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'X-Idempotency-Key': uuid(),
  };
  const fd = new FormData();
  fd.append(fieldName, file);
  const res = await fetch(path, { method: 'POST', headers, body: fd, credentials: 'include' });
  const text = await res.text();
  let data: unknown = null;
  if (text) { try { data = JSON.parse(text); } catch { data = text; } }
  if (!res.ok) {
    const { msg, code } = extractError(data, res.status);
    throw new ApiError(msg, res.status, code, data);
  }
  return data as T;
}

async function uploadFormData<T>(path: string, fd: FormData): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'X-Idempotency-Key': uuid(),
  };
  const res = await fetch(path, { method: 'POST', headers, body: fd, credentials: 'include' });
  const text = await res.text();
  let data: unknown = null;
  if (text) { try { data = JSON.parse(text); } catch { data = text; } }
  if (!res.ok) {
    const { msg, code } = extractError(data, res.status);
    throw new ApiError(msg, res.status, code, data);
  }
  return data as T;
}

export const api = {
  get: <T,>(p: string) => request<T>('GET', p),
  post: <T,>(p: string, b?: unknown) => request<T>('POST', p, b),
  put: <T,>(p: string, b?: unknown) => request<T>('PUT', p, b),
  patch: <T,>(p: string, b?: unknown) => request<T>('PATCH', p, b),
  del: <T,>(p: string) => request<T>('DELETE', p),
  upload: <T,>(p: string, file: File, fieldName?: string) => uploadRequest<T>(p, file, fieldName),
  uploadForm: <T,>(p: string, fd: FormData) => uploadFormData<T>(p, fd),
};
