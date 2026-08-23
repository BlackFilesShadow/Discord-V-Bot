const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1']);

/**
 * Etappe 48 darf echte Client-Pfade gegen ein lokales HTTP-Labor umleiten.
 * Die doppelte Schranke (expliziter Modus + Loopback-Host) verhindert, dass
 * diese Testnaht als allgemeiner Endpoint-Override verwendet werden kann.
 */
export function requireStage48LoopbackUrl(rawUrl: string): string {
  if (process.env.STAGE48_LAB_MODE !== '1') {
    throw new Error('STAGE48_LAB_MODE=1 ist fuer den Loopback-Override erforderlich');
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Ungueltige Stage-48-Loopback-URL');
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  if (parsed.protocol !== 'http:' || !LOOPBACK_HOSTS.has(hostname)) {
    throw new Error('Stage-48-Labor erlaubt ausschliesslich HTTP-Loopback-URLs');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('Stage-48-Loopback-URL darf keine Credentials, Query oder Fragmente enthalten');
  }

  return parsed.toString().replace(/\/$/, '');
}
