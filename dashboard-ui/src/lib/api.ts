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

function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
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
  if (method !== 'GET') headers['X-Idempotency-Key'] = uuid();
  return decode<T>(await fetch(path, { method, headers, body: payload, credentials: 'include' }));
}

async function formRequest<T>(method: 'POST' | 'PUT' | 'PATCH', path: string, fd: FormData): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json', 'X-Idempotency-Key': uuid() };
  return decode<T>(await fetch(path, { method, headers, body: fd, credentials: 'include' }));
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
