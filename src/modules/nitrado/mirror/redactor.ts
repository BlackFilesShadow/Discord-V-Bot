/**
 * Anonymisierung sensibler Server-Daten für AI-Prompts und Bot-Antworten.
 *
 * Regel (vom User vorgegeben):
 *   "Server-Bezogene Daten wie name, whitelist, Bannlist, IP usw. von den
 *    Nitrado-Server dürfen nicht erwähnt werden und müssen durch Platzhalter
 *    ergänzt werden — Anonym muss der Server bleiben."
 *
 * Wir trennen zwei Ebenen:
 *   1. SENSITIVE_KEYS: Werte solcher Settings-Keys werden komplett geredacted.
 *   2. SENSITIVE_PATTERNS: Tabu-Substrings (IPs, Steam64, GUIDs, ports, etc.)
 *      werden in beliebigem Text durch Platzhalter ersetzt.
 *
 * Das Modul ist STATELESS und PURE.
 */

/** Settings-Schlüssel deren Wert nicht ausgegeben werden darf. */
export const SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  // Server-Identität
  'hostname', 'name', 'serverName', 'servername',
  // Netzwerk
  'ip', 'ipAddress', 'address', 'port', 'queryPort', 'rconPort',
  // Auth
  'password', 'passwordAdmin', 'rconPassword', 'adminPassword',
  // Listen
  'whitelist', 'priority', 'admins', 'admin', 'bans', 'banlist',
  // Service
  'serviceId', 'service_id', 'username', 'owner',
]);

/** Felder, die schon im Schlüsselnamen sensibel klingen (Substring-Match). */
const SENSITIVE_KEY_HINTS = ['password', 'token', 'secret', 'key', 'whitelist', 'priority', 'admin', 'ban', 'ip', 'port', 'rcon'];

export const PLACEHOLDER = {
  server: '[SERVER]',
  ip: '[IP]',
  port: '[PORT]',
  steam64: '[STEAMID]',
  guid: '[GUID]',
  password: '[PASSWORT]',
  list: '[VERTRAULICHE_LISTE]',
  generic: '[VERTRAULICH]',
  serviceId: '[SERVICE]',
} as const;

const RE_IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/g;
const RE_IPV6 = /\b(?:[A-F0-9]{1,4}:){2,7}[A-F0-9]{1,4}\b/gi;
const RE_STEAM64 = /\b7656119\d{10}\b/g;
const RE_BATTLEYE_GUID = /\b[a-f0-9]{32}\b/gi;
const RE_DAYZ_CONSOLE_ID = /\b[A-Za-z0-9_-]{20,64}={0,2}\b/g;
const RE_PORT_FIELD = /\b(?:port|queryport|rconport)\s*[:=]\s*"?\d{2,5}"?/gi;

export interface RedactOptions {
  /** Optional: Service-/Server-Name, der zusätzlich zu maskieren ist. */
  serverName?: string | null;
  /** Optional: Service-ID, die zusätzlich zu maskieren ist. */
  serviceId?: string | null;
}

/**
 * Maskiert sensible Substrings in beliebigem Freitext (z.B. Datei-Inhalt
 * aus serverDZ.cfg, oder Snippet aus types.xml — falls dort etwas
 * Sensibles drin steht).
 */
export function redactText(input: string, opts: RedactOptions = {}): string {
  if (!input) return input;
  let out = input;
  // Konkrete Identitäten zuerst (Längste zuerst, sonst überlappen Patterns)
  if (opts.serverName && opts.serverName.length >= 3) {
    out = out.split(opts.serverName).join(PLACEHOLDER.server);
  }
  if (opts.serviceId) {
    out = out.split(String(opts.serviceId)).join(PLACEHOLDER.serviceId);
  }
  out = out.replace(RE_IPV4, PLACEHOLDER.ip);
  out = out.replace(RE_IPV6, PLACEHOLDER.ip);
  out = out.replace(RE_STEAM64, PLACEHOLDER.steam64);
  out = out.replace(RE_BATTLEYE_GUID, PLACEHOLDER.guid);
  out = out.replace(RE_PORT_FIELD, (m) => m.replace(/\d{2,5}/, PLACEHOLDER.port));
  // DayZ-Console-IDs: vorsichtig — könnte auch class-Namen treffen.
  // Nur wenn der String wie ein typischer Identifier aussieht (mit '_' oder '-' und gemischten Casings).
  out = out.replace(RE_DAYZ_CONSOLE_ID, (m) => {
    if (/^[A-Z][a-zA-Z]+$/.test(m)) return m; // ClassName (z.B. AKM, Mosin) durchlassen
    if (!/[_-]/.test(m) && !/=$/.test(m)) return m;
    return PLACEHOLDER.guid;
  });
  return out;
}

export function isSensitiveKey(key: string): boolean {
  if (SENSITIVE_KEYS.has(key)) return true;
  const lower = key.toLowerCase();
  return SENSITIVE_KEY_HINTS.some((h) => lower.includes(h));
}

/**
 * Redaktiert einen Settings-Wert basierend auf seinem Schlüssel.
 * Mehrzeilige Listen (whitelist/priority/admins) werden zu einer
 * "[VERTRAULICHE_LISTE: N Einträge]"-Zusammenfassung.
 */
export function redactValue(key: string, value: unknown, opts: RedactOptions = {}): unknown {
  if (value === null || value === undefined) return value;
  const sens = isSensitiveKey(key);
  if (typeof value === 'string') {
    if (sens) {
      // Listen-Heuristik
      if (/whitelist|priority|admin|ban/i.test(key)) {
        const lines = value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        if (lines.length > 1) return `${PLACEHOLDER.list} (${lines.length} Einträge)`;
        if (lines.length === 1) return PLACEHOLDER.list;
        return PLACEHOLDER.list;
      }
      if (/password|secret|token|rcon/i.test(key)) return PLACEHOLDER.password;
      if (/name|host/i.test(key)) return PLACEHOLDER.server;
      if (/^ip|address/i.test(key)) return PLACEHOLDER.ip;
      if (/port/i.test(key)) return PLACEHOLDER.port;
      return PLACEHOLDER.generic;
    }
    return redactText(value, opts);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    if (sens && /port/i.test(key)) return PLACEHOLDER.port;
    if (sens) return PLACEHOLDER.generic;
    return value;
  }
  if (Array.isArray(value)) {
    if (sens) return `${PLACEHOLDER.list} (${value.length} Einträge)`;
    return value.map((v) => redactValue(key, v, opts));
  }
  if (typeof value === 'object') {
    return redactObject(value as Record<string, unknown>, opts);
  }
  return value;
}

/** Rekursive Objekt-Redaktion. */
export function redactObject(obj: Record<string, unknown>, opts: RedactOptions = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = redactValue(k, v, opts);
  }
  return out;
}

/**
 * Setting-Key explizit erlaubt (für Whitelist-Modus): liefert den Wert,
 * falls der Key nicht sensibel ist; sonst Platzhalter.
 */
export function safeValue(key: string, value: unknown, opts: RedactOptions = {}): unknown {
  return redactValue(key, value, opts);
}
