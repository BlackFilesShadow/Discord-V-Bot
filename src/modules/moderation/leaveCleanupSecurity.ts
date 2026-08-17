const SECRET_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi,
  /\b(?:authorization|api[-_ ]?key|token|secret|password)\b\s*[:=]\s*[^\s,;]+/gi,
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Redigiert Fehler, bevor sie in persistente Leave-Cleanup-Metadaten gelangen.
 * Konkrete Game-/Remote-Identifier werden nur im RAM uebergeben und ersetzt.
 */
export function sanitizeLeaveCleanupError(error: unknown, sensitiveValues: string[] = []): string {
  let value = error instanceof Error ? error.message : String(error);
  value = value.replace(/[\r\n\t]+/g, ' ');

  for (const sensitive of sensitiveValues) {
    const candidate = sensitive.trim();
    if (!candidate) continue;
    value = value.replace(new RegExp(escapeRegExp(candidate), 'gi'), '[REDACTED]');
  }
  for (const pattern of SECRET_PATTERNS) {
    value = value.replace(pattern, match => {
      const separator = match.search(/[:=]/);
      if (separator >= 0) return `${match.slice(0, separator + 1)}[REDACTED]`;
      if (/^Bearer\s/i.test(match)) return 'Bearer [REDACTED]';
      return '[REDACTED]';
    });
  }
  return value.slice(0, 1000);
}
