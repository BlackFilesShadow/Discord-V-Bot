export interface ProviderFailureClassification {
  isRateLimit: boolean;
  isAuthOrModel: boolean;
}

/**
 * Klassifiziert HTTP-Fehler eines AI-Providers ohne Provider-spezifische
 * Seiteneffekte. Nur HTTP 429 ist ein Rate-Limit. 401/403/404 bedeuten einen
 * unbrauchbaren Key, fehlende Berechtigung oder ein ungueltiges Modell.
 */
export function classifyProviderHttpStatus(status?: number): ProviderFailureClassification {
  return {
    isRateLimit: status === 429,
    isAuthOrModel: status === 401 || status === 403 || status === 404,
  };
}

/**
 * `allRateLimited` darf nur true bleiben, wenn wirklich JEDER bisher
 * fehlgeschlagene Provider mit HTTP 429 geantwortet hat. Jeder andere Fehler
 * (inkl. 401/403/404, 5xx und Netzwerkfehler ohne Status) widerlegt diese
 * Aussage sofort.
 */
export function updateAllRateLimitedState(current: boolean, status?: number): boolean {
  return current && status === 429;
}
