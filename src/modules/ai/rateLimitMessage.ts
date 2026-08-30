export function formatProviderRateLimitMessage(retryAfterSeconds?: number): string {
  if (!retryAfterSeconds || !Number.isFinite(retryAfterSeconds) || retryAfterSeconds <= 0) {
    return '⏳ Die konfigurierten KI-Anbieter sind vorübergehend im Rate-Limit. Bitte versuch es später erneut.';
  }
  if (retryAfterSeconds < 90) {
    return `⏳ Die konfigurierten KI-Anbieter sind im Rate-Limit. Bitte warte noch etwa ${Math.ceil(retryAfterSeconds)} Sekunden.`;
  }
  return `⏳ Die konfigurierten KI-Anbieter sind im Rate-Limit. Bitte warte noch etwa ${Math.ceil(retryAfterSeconds / 60)} Minuten.`;
}
