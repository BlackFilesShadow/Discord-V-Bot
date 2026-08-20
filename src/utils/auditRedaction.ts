import { isSensitiveKey, redactText, redactValue } from '../modules/nitrado/mirror/redactor';

const AUDIT_SECRET_KEY_RE = /(token|secret|password|passwd|api[-_]?key|authorization|bearer|cookie|session|otp|2fa|nonce|client[-_]?secret|encryption[-_]?key|refresh[-_]?token|access[-_]?token)/i;
const REDACTED = '[REDACTED]';
// Authorization darf kein unbekanntes/custom Scheme durchlassen. Bekannte
// Schemes bleiben fuer Diagnosezwecke sichtbar, der komplette Credential-Rest
// der Zeile wird aber immer entfernt.
const AUTH_HEADER_RE = /\b(Authorization)\s*[:=]\s*([^\r\n]+)/gi;
const COOKIE_HEADER_RE = /\b(Cookie|Set-Cookie)\s*:\s*[^\r\n]+/gi;
const BEARER_RE = /\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g;
// Authorization/Cookie besitzen eigene strukturwahrende Header-Regeln oben.
// Weitere sicherheits-/Nitrado-sensitive Freitext-Labels werden fail-closed
// maskiert, damit auch Legacy-Details ausserhalb eines JSON-Key-Kontexts sicher
// bleiben.
const LABELED_SECRET_RE = /\b(token|secret|password|passwd|api[-_]?key|session|client[-_]?secret|refresh[-_]?token|access[-_]?token|serviceId|service_id|nitradoServerId|hostname|serverName|servername|whitelist|priority|admins?|banlist|bans|rconPassword)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;

function isAuditSecretKey(key: string): boolean {
  return AUDIT_SECRET_KEY_RE.test(key) || isSensitiveKey(key);
}

function redactAuditText(input: string): string {
  // Secret-Syntax muss vor der generischen DayZ-/Identifier-Redaction laufen.
  // Sonst kann z. B. ein Base64-Basic-Credential zuerst als GUID maskiert
  // werden und die Authorization-Regel erkennt den Header danach nicht mehr.
  const secretRedacted = input
    .replace(AUTH_HEADER_RE, (_match, header: string, rawValue: string) => {
      const scheme = rawValue.trim().match(/^(Bearer|Basic|Token)\b/i)?.[1];
      return scheme ? `${header}: ${scheme} ${REDACTED}` : `${header}: ${REDACTED}`;
    })
    .replace(COOKIE_HEADER_RE, (_match, header: string) => `${header}: ${REDACTED}`)
    .replace(BEARER_RE, (_match, prefix: string) => `${prefix} ${REDACTED}`)
    .replace(JWT_RE, REDACTED)
    .replace(LABELED_SECRET_RE, (_match, label: string) => `${label}=${REDACTED}`);

  return redactText(secretRedacted);
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
