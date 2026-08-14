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
import net from 'node:net';
import axios, { type AxiosRequestConfig, type AxiosResponse } from 'axios';

function parseIpv4(address: string): number[] | null {
  if (net.isIP(address) !== 4) return null;
  const octets = address.split('.').map(Number);
  return octets.length === 4 ? octets : null;
}

function parseIpv6Words(address: string): number[] | null {
  let input = address.toLowerCase();
  const zone = input.indexOf('%');
  if (zone >= 0) input = input.slice(0, zone);
  if (net.isIP(input) !== 6) return null;

  // IPv4-tail (z. B. ::ffff:127.0.0.1) in zwei Hextets umwandeln.
  const lastColon = input.lastIndexOf(':');
  const tail = input.slice(lastColon + 1);
  if (tail.includes('.')) {
    const ipv4 = parseIpv4(tail);
    if (!ipv4) return null;
    const hi = ((ipv4[0] << 8) | ipv4[1]).toString(16);
    const lo = ((ipv4[2] << 8) | ipv4[3]).toString(16);
    input = `${input.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const halves = input.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;

  const words = [
    ...left.map(v => Number.parseInt(v, 16)),
    ...Array.from({ length: missing }, () => 0),
    ...right.map(v => Number.parseInt(v, 16)),
  ];
  return words.length === 8 && words.every(v => Number.isInteger(v) && v >= 0 && v <= 0xffff)
    ? words
    : null;
}

export function isBlockedHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (!host) return true;

  // Hostnamen
  if (host === 'localhost' || host.endsWith('.localhost')) return true;

  const ipv4 = parseIpv4(host);
  if (ipv4) {
    const [a, b] = ipv4;
    if (a === 0) return true; // Current network / unspecified 0.0.0.0/8
    if (a === 10) return true; // Privat
    if (a === 127) return true; // Loopback
    if (a === 169 && b === 254) return true; // Link-local / Cloud-Metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // Privat 172.16/12
    if (a === 192 && b === 168) return true; // Privat
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
    if (a >= 224) return true; // Multicast / reserved 224.0.0.0/4 + 240.0.0.0/4
    return false;
  }

  const ipv6 = parseIpv6Words(host);
  if (ipv6) {
    const first = ipv6[0];
    const allZeroPrefix = ipv6.slice(0, 6).every(v => v === 0);

    if (ipv6.every(v => v === 0)) return true; // :: unspecified
    if (ipv6.slice(0, 7).every(v => v === 0) && ipv6[7] === 1) return true; // ::1 loopback
    if ((first & 0xfe00) === 0xfc00) return true; // ULA fc00::/7
    if ((first & 0xffc0) === 0xfe80) return true; // Link-local fe80::/10 (fe80..febf)
    if ((first & 0xffc0) === 0xfec0) return true; // Deprecated site-local/reserved fec0::/10
    if ((first & 0xff00) === 0xff00) return true; // Multicast ff00::/8

    // IPv4-mapped (::ffff:a.b.c.d) sowie IPv4-compatible (::a.b.c.d)
    // auf dieselben IPv4-Regeln zurueckfuehren. Das deckt auch Hex-Schreibweisen
    // wie ::ffff:7f00:1 ab, die ein reiner dotted-decimal Regex uebersehen wuerde.
    const mapped = ipv6.slice(0, 5).every(v => v === 0) && ipv6[5] === 0xffff;
    if (mapped || allZeroPrefix) {
      const embedded = `${ipv6[6] >> 8}.${ipv6[6] & 0xff}.${ipv6[7] >> 8}.${ipv6[7] & 0xff}`;
      return isBlockedHost(embedded);
    }
    return false;
  }

  // Nicht-IP-Hostnamen werden beim echten Connect zusaetzlich via safeLookup
  // auf ihre aufgeloesten Zieladressen validiert und auf diese gepinnt.
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
