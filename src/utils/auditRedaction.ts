import { isSensitiveKey, redactText, redactValue } from '../modules/nitrado/mirror/redactor';

const AUDIT_SECRET_KEY_RE = /(token|secret|password|passwd|api[-_]?key|authorization|bearer|cookie|session|otp|2fa|nonce|client[-_]?secret|encryption[-_]?key|refresh[-_]?token|access[-_]?token)/i;
const REDACTED = '[REDACTED]';
const AUTH_HEADER_RE = /\b(Authorization)\s*[:=]\s*(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]+/gi;
const COOKIE_HEADER_RE = /\b(Cookie|Set-Cookie)\s*:\s*[^\r\n]+/gi;
const BEARER_RE = /\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g;
// Authorization/Cookie besitzen eigene strukturwahrende Header-Regeln oben.
// Sie duerfen hier nicht ein zweites Mal als generisches Label gematcht werden,
// sonst wuerde z. B. "Authorization: Basic [REDACTED]" erneut zerlegt.
const LABELED_SECRET_RE = /\b(token|secret|password|passwd|api[-_]?key|session|client[-_]?secret|refresh[-_]?token|access[-_]?token)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;

function isAuditSecretKey(key: string): boolean {
  return AUDIT_SECRET_KEY_RE.test(key) || isSensitiveKey(key);
}

function redactAuditText(input: string): string {
  return redactText(input)
    .replace(AUTH_HEADER_RE, (_match, header: string, scheme: string) => `${header}: ${scheme} ${REDACTED}`)
    .replace(COOKIE_HEADER_RE, (_match, header: string) => `${header}: ${REDACTED}`)
    .replace(BEARER_RE, (_match, prefix: string) => `${prefix} ${REDACTED}`)
    .replace(JWT_RE, REDACTED)
    .replace(LABELED_SECRET_RE, (_match, label: string) => `${label}=${REDACTED}`);
}

/**
 * Fail-closed redaction for arbitrary AuditLog JSON values.
 *
 * Unlike the Nitrado object helper this deliberately accepts every JSON shape:
 * top-level strings, arrays and nested objects are all traversed. This is used
 * both before DB persistence and again when legacy rows are returned to the
 * dashboard, so historic unredacted rows cannot bypass the current policy.
 */
export function redactAuditDetails(value: unknown, key?: string): unknown {
  if (value === null || value === undefined) return value;

  if (key && isAuditSecretKey(key)) return REDACTED;

  if (Array.isArray(value)) {
    return value.map(item => redactAuditDetails(item));
  }

  if (value instanceof Date) return value.toISOString();

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      out[childKey] = redactAuditDetails(childValue, childKey);
    }
    return out;
  }

  if (key) {
    const redacted = redactValue(key, value);
    return typeof redacted === 'string' ? redactAuditText(redacted) : redacted;
  }
  if (typeof value === 'string') return redactAuditText(value);
  return value;
}

export const AUDIT_REDACTED_VALUE = REDACTED;
