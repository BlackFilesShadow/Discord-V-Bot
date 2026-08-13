import { XMLParser } from 'fast-xml-parser';
import { safeAxiosGet } from '../../utils/ssrf';

export interface FeedEntry {
  id: string;
  title: string;
  link: string;
  description: string;
  publishedAt: string | null;
  image: string | null;
}

export interface FeedDocument {
  sourceUrl: string;
  title: string | null;
  entries: FeedEntry[];
  format: 'RSS' | 'ATOM' | 'RSS1' | 'JSON';
}

function scalar(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value).trim();
  if (Array.isArray(value)) return scalar(value[0]);
  if (typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return scalar(o['#text'] ?? o.__cdata ?? o._text ?? o.value ?? '');
  }
  return '';
}

function decodeEntities(text: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return text
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => named[String(n).toLowerCase()] ?? m);
}

export function plainText(value: unknown, max = 4096): string {
  const raw = scalar(value);
  const cleaned = decodeEntities(raw)
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\t\r ]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return cleaned.slice(0, max);
}

function absoluteUrl(value: string, base: string): string {
  if (!value) return '';
  try { return new URL(value, base).toString(); } catch { return ''; }
}

function httpUrl(value: unknown, base: string): string {
  const raw = scalar(value);
  if (!raw) return '';
  const full = absoluteUrl(raw, base);
  return /^https?:\/\//i.test(full) ? full : '';
}

function atomLink(value: unknown, base: string): string {
  const links = Array.isArray(value) ? value : value ? [value] : [];
  for (const candidate of links) {
    if (typeof candidate === 'string') {
      const u = httpUrl(candidate, base); if (u) return u;
      continue;
    }
    if (!candidate || typeof candidate !== 'object') continue;
    const o = candidate as Record<string, unknown>;
    const rel = scalar(o['@_rel']) || 'alternate';
    const type = scalar(o['@_type']);
    if (rel === 'alternate' && (!type || /html|xhtml/i.test(type))) {
      const u = httpUrl(o['@_href'], base); if (u) return u;
    }
  }
  for (const candidate of links) {
    if (candidate && typeof candidate === 'object') {
      const u = httpUrl((candidate as Record<string, unknown>)['@_href'], base); if (u) return u;
    }
  }
  return '';
}

function imageFromXml(item: Record<string, unknown>, base: string): string | null {
  const candidates: unknown[] = [item['media:thumbnail'], item['itunes:image']];
  const media = item['media:content'];
  if (media) {
    const arr = Array.isArray(media) ? [...media] : [media];
    arr.sort((a, b) => Number((b as any)?.['@_width'] ?? 0) - Number((a as any)?.['@_width'] ?? 0));
    candidates.unshift(...arr.filter((m: any) => !m?.['@_medium'] || m['@_medium'] === 'image' || String(m?.['@_type'] ?? '').startsWith('image/')));
  }
  const enclosure = item.enclosure;
  if (enclosure) candidates.push(...(Array.isArray(enclosure) ? enclosure : [enclosure]));
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (typeof candidate === 'object') {
      const o = candidate as Record<string, unknown>;
      const type = scalar(o['@_type']);
      const raw = scalar(o['@_url'] ?? o['@_href']);
      if (raw && (!type || type.startsWith('image/') || /\.(png|jpe?g|gif|webp)(?:\?|$)/i.test(raw))) {
        const u = absoluteUrl(raw, base); if (/^https?:\/\//i.test(u)) return u;
      }
    }
  }
  const html = scalar(item['content:encoded'] ?? item.content ?? item.description ?? item.summary);
  const match = html.match(/<img[^>]+(?:src|data-src)=["']([^"']+)["']/i);
  if (match) { const u = absoluteUrl(match[1], base); if (/^https?:\/\//i.test(u)) return u; }
  return null;
}

function validDate(value: unknown): string | null {
  const raw = scalar(value);
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function stableId(...values: unknown[]): string {
  for (const v of values) { const s = scalar(v); if (s) return s; }
  return '';
}

function parseXml(data: string, sourceUrl: string): FeedDocument {
  const parser = new XMLParser({ ignoreAttributes: false, trimValues: false, processEntities: false });
  const parsed = parser.parse(data) as Record<string, any>;
  if (parsed.rss?.channel) {
    const ch = parsed.rss.channel;
    const raw = Array.isArray(ch.item) ? ch.item : ch.item ? [ch.item] : [];
    return { sourceUrl, title: plainText(ch.title, 300) || null, format: 'RSS', entries: raw.map((x: any, i: number) => {
      const item = x as Record<string, unknown>;
      const link = httpUrl(item.link, sourceUrl);
      const title = plainText(item.title, 500) || 'Ohne Titel';
      const id = stableId(item.guid, link, title, `rss-${i}`);
      return { id, title, link, description: plainText(item['content:encoded'] ?? item.description ?? item.summary, 4096), publishedAt: validDate(item.pubDate ?? item['dc:date']), image: imageFromXml(item, sourceUrl) };
    }).filter((e: FeedEntry) => Boolean(e.id)) };
  }
  if (parsed.feed) {
    const feed = parsed.feed;
    const raw = Array.isArray(feed.entry) ? feed.entry : feed.entry ? [feed.entry] : [];
    return { sourceUrl, title: plainText(feed.title, 300) || null, format: 'ATOM', entries: raw.map((x: any, i: number) => {
      const item = x as Record<string, unknown>;
      const link = atomLink(item.link, sourceUrl);
      const title = plainText(item.title, 500) || 'Ohne Titel';
      const id = stableId(item.id, link, title, `atom-${i}`);
      return { id, title, link, description: plainText(item.summary ?? item.content, 4096), publishedAt: validDate(item.published ?? item.updated), image: imageFromXml(item, sourceUrl) };
    }).filter((e: FeedEntry) => Boolean(e.id)) };
  }
  const rdf = parsed['rdf:RDF'] ?? parsed.RDF;
  if (rdf) {
    const raw = Array.isArray(rdf.item) ? rdf.item : rdf.item ? [rdf.item] : [];
    const ch = rdf.channel ?? {};
    return { sourceUrl, title: plainText(ch.title, 300) || null, format: 'RSS1', entries: raw.map((x: any, i: number) => {
      const item = x as Record<string, unknown>;
      const link = httpUrl(item.link ?? item['@_rdf:about'], sourceUrl);
      const title = plainText(item.title, 500) || 'Ohne Titel';
      return { id: stableId(item['@_rdf:about'], link, title, `rdf-${i}`), title, link, description: plainText(item.description ?? item['content:encoded'], 4096), publishedAt: validDate(item['dc:date']), image: imageFromXml(item, sourceUrl) };
    }) };
  }
  throw new Error('Kein unterstützter RSS-/Atom-Feed erkannt.');
}

function parseJson(data: string, sourceUrl: string): FeedDocument {
  let root: any;
  try { root = JSON.parse(data); } catch { throw new Error('Ungültiges JSON-Feed-Dokument.'); }
  if (!root || !Array.isArray(root.items) || typeof root.version !== 'string' || !/jsonfeed\.org\/version\//i.test(root.version)) throw new Error('Kein gültiger JSON Feed erkannt.');
  const entries: FeedEntry[] = root.items.map((item: any, i: number) => {
    const link = httpUrl(item.url ?? item.external_url, sourceUrl);
    const title = plainText(item.title, 500) || plainText(item.summary, 120) || 'Ohne Titel';
    const id = stableId(item.id, link, title, `json-${i}`);
    let image = httpUrl(item.image ?? item.banner_image, sourceUrl) || null;
    if (!image && Array.isArray(item.attachments)) {
      const attachment = item.attachments.find((a: any) => typeof a?.mime_type === 'string' && a.mime_type.startsWith('image/'));
      image = attachment ? httpUrl(attachment.url, sourceUrl) || null : null;
    }
    return { id, title, link, description: plainText(item.content_text ?? item.content_html ?? item.summary, 4096), publishedAt: validDate(item.date_published ?? item.date_modified), image };
  });
  return { sourceUrl, title: plainText(root.title, 300) || null, format: 'JSON', entries };
}

export function parseFeedDocument(data: string, sourceUrl: string, contentType = ''): FeedDocument {
  const trimmed = data.trim();
  if (/application\/(?:feed\+)?json/i.test(contentType) || trimmed.startsWith('{')) return parseJson(trimmed, sourceUrl);
  return parseXml(trimmed, sourceUrl);
}

function discoverFeedUrl(html: string, pageUrl: string): string | null {
  const links = [...html.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]);
  const options: { href: string; score: number }[] = [];
  for (const tag of links) {
    const rel = tag.match(/\brel\s*=\s*["']([^"']+)["']/i)?.[1] ?? '';
    if (!/\balternate\b/i.test(rel)) continue;
    const type = tag.match(/\btype\s*=\s*["']([^"']+)["']/i)?.[1]?.toLowerCase() ?? '';
    if (!/(application\/(rss\+xml|atom\+xml|feed\+json|json)|text\/xml)/.test(type)) continue;
    const href = tag.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!href) continue;
    const full = absoluteUrl(decodeEntities(href), pageUrl);
    if (!/^https?:\/\//i.test(full)) continue;
    options.push({ href: full, score: type.includes('feed+json') ? 4 : type.includes('rss+xml') ? 3 : type.includes('atom+xml') ? 2 : 1 });
  }
  options.sort((a, b) => b.score - a.score);
  return options[0]?.href ?? null;
}

export async function fetchFeedDocument(url: string, allowHtmlDiscovery = false): Promise<FeedDocument> {
  const first = await safeAxiosGet<string>(url, { timeout: 12_000, responseType: 'text', headers: { Accept: 'application/feed+json, application/rss+xml, application/atom+xml, application/xml, text/xml, application/json, text/html;q=0.8, */*;q=0.2', 'User-Agent': 'V-Bot-FeedReader/2.0' } });
  const type = String(first.headers['content-type'] ?? '');
  const body = String(first.data ?? '');
  try { return parseFeedDocument(body, url, type); }
  catch (initialError) {
    if (!allowHtmlDiscovery || !/text\/html|application\/xhtml\+xml/i.test(type) && !/<html\b/i.test(body.slice(0, 2000))) throw initialError;
    const discovered = discoverFeedUrl(body, url);
    if (!discovered) throw new Error('Auf der Webseite wurde kein RSS-, Atom- oder JSON-Feed gefunden.');
    const second = await safeAxiosGet<string>(discovered, { timeout: 12_000, responseType: 'text', headers: { Accept: 'application/feed+json, application/rss+xml, application/atom+xml, application/xml, text/xml, application/json, */*;q=0.2', 'User-Agent': 'V-Bot-FeedReader/2.0' } });
    return parseFeedDocument(String(second.data ?? ''), discovered, String(second.headers['content-type'] ?? ''));
  }
}

export function entriesAfterMarker(entries: FeedEntry[], marker: string | null, firstRun: 'latest' | 'mark-only'): { toPost: FeedEntry[]; latestId: string | null; markerFound: boolean } {
  const clean = entries.filter((e) => e.id).slice(0, 50);
  const latestId = clean[0]?.id ?? null;
  if (!clean.length) return { toPost: [], latestId: marker, markerFound: Boolean(marker) };
  if (!marker) return { toPost: firstRun === 'latest' ? [clean[0]] : [], latestId, markerFound: false };
  const index = clean.findIndex((e) => e.id === marker);
  if (index === 0) return { toPost: [], latestId: marker, markerFound: true };
  if (index > 0) return { toPost: clean.slice(0, index).reverse(), latestId, markerFound: true };
  // Marker ausserhalb des aktuellen Fensters: kein Backlog-Spam. Nur den neuesten Eintrag senden.
  return { toPost: latestId !== marker ? [clean[0]] : [], latestId, markerFound: false };
}
