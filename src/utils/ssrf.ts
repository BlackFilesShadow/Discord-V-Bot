/**
 * SSRF-Schutz-Helfer.
 *
 * Prueft, ob ein Hostname auf einen privaten, lokalen oder anderweitig
 * blockierten Netzbereich zeigt (IPv4 Loopback/Private/Link-Local/CGNAT,
 * IPv6 Loopback/Link-Local/ULA, IPv4-mapped IPv6).
 *
 * Hinweis: Dies ist eine STATISCHE Hostname-Pruefung. Vollstaendiger
 * SSRF-Schutz gegen DNS-Rebinding erfordert zusaetzlich eine Aufloesung der
 * IP zum Fetch-Zeitpunkt (hier nicht abgedeckt).
 */
export function isBlockedHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (!host) return true;

  // IPv6-Literale (enthalten ':')
  if (host.includes(':')) {
    if (host === '::1' || host === '::') return true; // Loopback / unspecified
    if (host.startsWith('fe80:')) return true; // Link-local
    if (/^f[cd][0-9a-f]{2}:/.test(host)) return true; // ULA fc00::/7
    const mapped = host.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (mapped) return isBlockedHost(mapped[1]); // IPv4-mapped IPv6
    return false;
  }

  // Hostnamen
  if (host === 'localhost' || host.endsWith('.localhost')) return true;

  // IPv4
  if (host === '0.0.0.0') return true;
  if (/^127\./.test(host)) return true; // Loopback
  if (/^10\./.test(host)) return true; // Privat
  if (/^192\.168\./.test(host)) return true; // Privat
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true; // Privat 172.16/12
  if (/^169\.254\./.test(host)) return true; // Link-local / Cloud-Metadata
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)) return true; // CGNAT 100.64/10

  return false;
}

/**
 * Prueft, ob eine URL oeffentlich per http(s) erreichbar und kein privater
 * Host ist. Liefert bei Erfolg das geparste URL-Objekt.
 */
export function validatePublicHttpUrl(
  raw: string,
): { ok: true; url: URL } | { ok: false; reason: string } {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return { ok: false, reason: 'Ungueltige URL.' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, reason: 'Nur http:// oder https:// URLs erlaubt.' };
  }
  if (isBlockedHost(u.hostname)) {
    return { ok: false, reason: 'Lokale/private Hosts sind nicht erlaubt (SSRF-Schutz).' };
  }
  return { ok: true, url: u };
}
