export interface ProviderFailureClassification {
  isRateLimit: boolean;
  isAuthOrModel: boolean;
}

/**
 * Klassifiziert HTTP-Fehler eines AI-Providers ohne Provider-spezifische
 * Seiteneffekte. Nur HTTP 429 ist ein Rate-Limit. 401/403/404 bedeuten einen
 * unbrauchbaren Key, fehlende Berechtigung oder ein ungueltiges Modell.
 *
 * HTTP 402 wird von AI-Providern fuer fehlendes Guthaben/gesperrte Abrechnung
 * verwendet. Fuer den laufenden Request-Pfad ist dieser Provider ebenfalls
 * nicht nutzbar und wird deshalb wie ein harter Provider-Circuit behandelt,
 * statt bei jeder Discord-Anfrage erneut sinnlos aufgerufen zu werden.
 */
export function classifyProviderHttpStatus(status?: number): ProviderFailureClassification {
  return {
    isRateLimit: status === 429,
    isAuthOrModel: status === 401 || status === 402 || status === 403 || status === 404,
  };
}

/**
 * `allRateLimited` darf nur true bleiben, wenn wirklich JEDER bisher
 * fehlgeschlagene Provider mit HTTP 429 geantwortet hat. Jeder andere Fehler
 * (inkl. 401/402/403/404, 5xx und Netzwerkfehler ohne Status) widerlegt diese
 * Aussage sofort.
 */
export function updateAllRateLimitedState(current: boolean, status?: number): boolean {
  return current && status === 429;
}
