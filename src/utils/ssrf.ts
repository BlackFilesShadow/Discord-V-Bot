/**
 * SSRF-Schutz-Helfer.
 *
 * Prueft, ob ein Hostname auf einen privaten, lokalen oder anderweitig
 * blockierten Netzbereich zeigt (IPv4 Loopback/Private/Link-Local/CGNAT,
 * IPv6 Loopback/Link-Local/ULA, IPv4-mapped IPv6).
 *
 * `safeAxiosGet` schliesst zusaetzlich die DNS-Rebinding- und Redirect-Luecke:
 * Der Socket verbindet ausschliesslich zu einer aufgeloesten, freigegebenen IP
 * (gepinnte lookup-Funktion) und jeder Redirect-Hop wird erneut validiert.
 */
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import axios, { type AxiosRequestConfig, type AxiosResponse } from 'axios';

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

/** Maximale Antwortgroesse fuer SSRF-gehaertete Fetches (10 MiB). */
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

/**
 * DNS-lookup, der ausschliesslich freigegebene (oeffentliche) IP-Adressen
 * zurueckgibt. Wird als `lookup` im http/https-Agent verwendet, sodass der
 * Socket garantiert zur validierten IP verbindet (kein DNS-Rebinding-Fenster
 * zwischen Pruefung und Connect).
 */
export function safeLookup(
  hostname: string,
  options: dns.LookupOneOptions | dns.LookupAllOptions | number,
  callback: (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void,
): void {
  const base = typeof options === 'number' ? { family: options } : (options ?? {});
  dns.lookup(hostname, { ...base, all: true, verbatim: true }, (err, addresses) => {
    if (err) { callback(err, '', 0); return; }
    const allowed = (addresses as dns.LookupAddress[]).filter((a) => !isBlockedHost(a.address));
    if (allowed.length === 0) {
      const blockErr = new Error(`SSRF-Schutz: ${hostname} loest ausschliesslich auf blockierte Adressen auf.`) as NodeJS.ErrnoException;
      blockErr.code = 'EAI_AGAIN';
      callback(blockErr, '', 0);
      return;
    }
    if ((base as dns.LookupAllOptions).all) {
      callback(null, allowed, undefined);
    } else {
      callback(null, allowed[0].address, allowed[0].family);
    }
  });
}

function safeAgents(): { httpAgent: http.Agent; httpsAgent: https.Agent } {
  return {
    httpAgent: new http.Agent({ lookup: safeLookup } as unknown as http.AgentOptions),
    httpsAgent: new https.Agent({ lookup: safeLookup } as unknown as https.AgentOptions),
  };
}

/**
 * SSRF-gehaerteter GET: validiert die URL, verbindet nur zu freigegebenen IPs
 * (gepinnter lookup), folgt Redirects manuell und validiert jeden Hop erneut,
 * und begrenzt die Antwortgroesse. Fuer alle Fetches von nutzergesteuerten URLs
 * (Feeds, externe Bilder) zu verwenden.
 */
export async function safeAxiosGet<T = unknown>(
  rawUrl: string,
  config: AxiosRequestConfig = {},
  maxRedirects = 5,
): Promise<AxiosResponse<T>> {
  const { httpAgent, httpsAgent } = safeAgents();
  let current = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const v = validatePublicHttpUrl(current);
    if (!v.ok) throw new Error(`SSRF-Schutz: ${v.reason}`);
    const res = await axios.request<T>({
      ...config,
      url: current,
      method: config.method ?? 'get',
      maxRedirects: 0,
      httpAgent,
      httpsAgent,
      maxContentLength: config.maxContentLength ?? MAX_RESPONSE_BYTES,
      maxBodyLength: config.maxBodyLength ?? MAX_RESPONSE_BYTES,
      validateStatus: () => true,
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers['location'];
      if (!loc || typeof loc !== 'string') throw new Error('SSRF-Schutz: Redirect ohne gueltige Location.');
      current = new URL(loc, current).toString();
      continue;
    }
    const accept = config.validateStatus ?? ((s: number) => s >= 200 && s < 300);
    if (!accept(res.status)) throw new Error(`HTTP ${res.status}`);
    return res;
  }
  throw new Error('SSRF-Schutz: Zu viele Redirects.');
}
