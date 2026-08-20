import { AuditCategory } from '@prisma/client';

export const AUDIT_DEFAULT_LIMIT = 50;
export const AUDIT_MAX_LIMIT = 100;
export const AUDIT_ACTION_MAX_LENGTH = 120;

const STRICT_LIMIT_RE = /^(?:[1-9]|[1-9]\d|100)$/;
const STRICT_UTC_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CURSOR_PAYLOAD_RE = /^[A-Za-z0-9_-]+$/;
const CURSOR_PREFIX = 'v1.';
const MAX_CURSOR_LENGTH = 512;

export class AuditQueryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuditQueryValidationError';
  }
}

export interface AuditCursor {
  createdAt: Date;
  id: string;
}

export function parseAuditLimit(raw: unknown): number {
  if (raw === undefined) return AUDIT_DEFAULT_LIMIT;
  if (typeof raw !== 'string' || !STRICT_LIMIT_RE.test(raw)) {
    throw new AuditQueryValidationError(`limit muss eine ganze Zahl zwischen 1 und ${AUDIT_MAX_LIMIT} sein.`);
  }
  return Number(raw);
}

export function parseAuditCategory(raw: unknown): AuditCategory | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new AuditQueryValidationError('category ungueltig.');
  }
  if (!(Object.values(AuditCategory) as string[]).includes(raw)) {
    throw new AuditQueryValidationError('Unbekannte Audit-Kategorie.');
  }
  return raw as AuditCategory;
}

export function parseAuditAction(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') throw new AuditQueryValidationError('action ungueltig.');
  const value = raw.trim();
  if (!value) return undefined;
  if (value.length > AUDIT_ACTION_MAX_LENGTH) {
    throw new AuditQueryValidationError(`action darf maximal ${AUDIT_ACTION_MAX_LENGTH} Zeichen enthalten.`);
  }
  if (/[\u0000-\u001F\u007F]/.test(value)) {
    throw new AuditQueryValidationError('action enthaelt ungueltige Steuerzeichen.');
  }
  return value;
}

export function encodeAuditCursor(cursor: AuditCursor): string {
  const createdAt = cursor.createdAt.toISOString();
  if (!UUID_RE.test(cursor.id)) throw new AuditQueryValidationError('Audit-Cursor-ID ungueltig.');
  const payload = Buffer.from(JSON.stringify({ t: createdAt, id: cursor.id }), 'utf8').toString('base64url');
  return `${CURSOR_PREFIX}${payload}`;
}

export function decodeAuditCursor(raw: unknown): AuditCursor | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_CURSOR_LENGTH || !raw.startsWith(CURSOR_PREFIX)) {
    throw new AuditQueryValidationError('cursor ungueltig.');
  }
  const encoded = raw.slice(CURSOR_PREFIX.length);
  if (!encoded || !CURSOR_PAYLOAD_RE.test(encoded)) throw new AuditQueryValidationError('cursor ungueltig.');

  let parsed: unknown;
  try {
    const json = Buffer.from(encoded, 'base64url').toString('utf8');
    parsed = JSON.parse(json);
  } catch {
    throw new AuditQueryValidationError('cursor ungueltig.');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AuditQueryValidationError('cursor ungueltig.');
  }
  const obj = parsed as Record<string, unknown>;
  if (Object.keys(obj).sort().join(',') !== 'id,t' || typeof obj.t !== 'string' || typeof obj.id !== 'string') {
    throw new AuditQueryValidationError('cursor ungueltig.');
  }
  if (!STRICT_UTC_ISO_RE.test(obj.t) || !UUID_RE.test(obj.id)) {
    throw new AuditQueryValidationError('cursor ungueltig.');
  }
  const createdAt = new Date(obj.t);
  if (Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== obj.t) {
    throw new AuditQueryValidationError('cursor ungueltig.');
  }
  return { createdAt, id: obj.id };
}

/**
 * Tie-breaker matching `ORDER BY createdAt DESC, id DESC`.
 * The next page is strictly older, or for an equal timestamp strictly below
 * the previous UUID, so equal timestamps cannot disappear between pages.
 */
export function auditCursorFilter(cursor: AuditCursor): {
  OR: Array<
    | { createdAt: { lt: Date } }
    | { createdAt: Date; id: { lt: string } }
  >;
} {
  return {
    OR: [
      { createdAt: { lt: cursor.createdAt } },
      { createdAt: cursor.createdAt, id: { lt: cursor.id } },
    ],
  };
}
