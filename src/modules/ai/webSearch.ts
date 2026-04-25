import axios from 'axios';
import { logger } from '../../utils/logger';

/**
 * Web-Search-Modul fuer aktuelle Fakten.
 *
 * Strategie:
 * 1) Wikipedia (deutsch) - sehr aktuelle Politik-/Personen-Daten, frei, ohne Key
 * 2) DuckDuckGo Instant Answer API - Fallback fuer allgemeine Themen
 *
 * Beide Quellen sind tagesaktuell und frei zugaenglich.
 */

const HTTP_TIMEOUT = 6000;
const USER_AGENT = 'V-Bot/1.0 (Discord AI assistant; +https://example.local)';

export interface WebSearchResult {
  source: string;
  title: string;
  snippet: string;
  url?: string;
}

/**
 * Wichtige Infobox-Felder, die fuer Aktualitaetsfragen relevant sind.
 * Werden aus dem Roh-Wikitext extrahiert, weil der reine Plaintext-Extract
 * den aktuellen Amtsinhaber oft nicht im Intro nennt.
 */
const INFOBOX_KEYS = [
  'Amtsinhaber', 'Inhaber', 'Amtierender', 'Amtsinhaberin',
  'Pr\u00e4sident', 'Praesident', 'Bundespr\u00e4sident',
  'Kanzler', 'Bundeskanzler', 'Premier', 'Premierminister',
  'Vorsitzender', 'Vorsitzende', 'Parteivorsitzender',
  'Aktueller_Sieger', 'Aktueller Sieger', 'Titeltr\u00e4ger',
  'Amtsantritt', 'Amtszeit', 'Im Amt seit', 'Im_Amt_seit',
  'Geschaeftsfuehrer', 'Gesch\u00e4ftsf\u00fchrer', 'CEO',
];

/**
 * Domain-spezifische Themen, fuer die wir gezielt eine zusaetzliche
 * Wikipedia-Suche mit kanonischem Begriff durchfuehren und vertrauens-
 * wuerdige offizielle Quellen als Hintergrund-Wissen einblenden.
 *
 * Trigger: einer der `keywords` muss in der Frage vorkommen (case-insensitive).
 * `wikiQuery`: kanonischer Suchbegriff fuer Wikipedia.
 * `sources`: offizielle / verlaessliche URLs, die der AI als Hinweis dienen.
 */
interface DomainTopic {
  id: string;
  keywords: RegExp;
  wikiQuery: string;
  sources: { title: string; url: string; note: string }[];
}

const DOMAIN_TOPICS: DomainTopic[] = [
  {
    id: 'nitrado',
    keywords: /\b(nitrado)\b/i,
    wikiQuery: 'Nitrado',
    sources: [
      { title: 'Nitrado Hilfe-Center', url: 'https://help.nitrado.net/', note: 'Offizielle Hilfe & Tutorials zu Nitrado-Gameservern' },
      { title: 'Nitrado Webinterface', url: 'https://server.nitrado.net/', note: 'Server-Verwaltung (Restart, Mods, Konfig)' },
    ],
  },
  {
    id: 'fs25',
    keywords: /\b(fs ?25|ls ?25|farming[\s-]?simulator(\s*25)?|landwirtschafts[\s-]?simulator(\s*25)?)\b/i,
    wikiQuery: 'Landwirtschafts-Simulator 25',
    sources: [
      { title: 'Farming Simulator 25 (offiziell)', url: 'https://www.farming-simulator.com/', note: 'Hersteller-Seite GIANTS Software' },
      { title: 'ModHub (offizieller Mod-Katalog)', url: 'https://www.farming-simulator.com/mods.php', note: 'Geprueftes Mod-Verzeichnis fuer FS25' },
    ],
  },
  {
    id: 'giants',
    keywords: /\b(giants(\s*software)?)\b/i,
    wikiQuery: 'Giants Software',
    sources: [
      { title: 'GIANTS Software', url: 'https://www.giants-software.com/', note: 'Entwicklerstudio des Farming Simulator' },
    ],
  },
  {
    id: 'modhub',
    keywords: /\b(mod[\s-]?hub)\b/i,
    wikiQuery: 'Farming Simulator ModHub',
    sources: [
      { title: 'ModHub', url: 'https://www.farming-simulator.com/mods.php', note: 'Offizielles, gepruefes Mod-Verzeichnis' },
    ],
  },
  {
    id: 'gameserver',
    keywords: /\b(game[\s-]?server|gameserver)\b/i,
    wikiQuery: 'Spieleserver',
    sources: [
      { title: 'Nitrado Gameserver', url: 'https://server.nitrado.net/', note: 'Beispiel-Anbieter fuer Gameserver-Hosting' },
    ],
  },
  {
    id: 'pterodactyl',
    keywords: /\b(pterodactyl|pelican[\s-]?panel)\b/i,
    wikiQuery: 'Pterodactyl Panel',
    sources: [
      { title: 'Pterodactyl Panel', url: 'https://pterodactyl.io/', note: 'Open-Source-Gameserver-Verwaltungspanel' },
    ],
  },
];

function detectDomainTopics(question: string): DomainTopic[] {
  return DOMAIN_TOPICS.filter((t) => t.keywords.test(question));
}

function stripWikiMarkup(s: string): string {
  return s
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, '')
    .replace(/<ref[^/]*\/>/gi, '')
    .replace(/<!--([\s\S]*?)-->/g, '')
    .replace(/\{\{[^{}]*\}\}/g, '')
    .replace(/\[\[(?:[^\]|]*\|)?([^\]]+)\]\]/g, '$1')
    .replace(/'''?/g, '')
    .replace(/<br\s*\/?\s*>/gi, ', ')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractInfoboxFacts(wikitext: string): string {
  const facts: string[] = [];
  // Erfasst "| Key = Value" bis zum naechsten "\n|" oder "}}"
  const re = /\n\s*\|\s*([A-Za-z\u00c4\u00d6\u00dc\u00e4\u00f6\u00fc_\u00df ]+?)\s*=\s*([\s\S]*?)(?=\n\s*\||\n\}\})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(wikitext)) !== null) {
    const key = m[1].trim();
    if (!INFOBOX_KEYS.some((k) => key.toLowerCase() === k.toLowerCase())) continue;
    const val = stripWikiMarkup(m[2]).slice(0, 200);
    if (val && val.length > 1) facts.push(`${key}: ${val}`);
  }
  return facts.join('\n');
}

/**
 * Wikipedia (de) durchsuchen und ersten Treffer + Extract + Infobox-Fakten zurueckliefern.
 */
async function searchWikipedia(query: string, limit = 3): Promise<WebSearchResult[]> {
  const out: WebSearchResult[] = [];
  try {
    const apiUrl = 'https://de.wikipedia.org/w/api.php';
    // 1) Suche - mehrere Treffer
    const searchRes = await axios.get(apiUrl, {
      timeout: HTTP_TIMEOUT,
      headers: { 'User-Agent': USER_AGENT },
      params: {
        action: 'query',
        list: 'search',
        srsearch: query,
        srlimit: limit,
        format: 'json',
        utf8: 1,
      },
    });
    const hits = searchRes.data?.query?.search;
    if (!Array.isArray(hits) || hits.length === 0) return out;

    // 2) Fuer jeden Treffer parallel: Plaintext-Extract + Infobox-Wikitext
    const detailPromises = hits.slice(0, limit).map(async (h: any) => {
      const title: string = h.title;
      try {
        const [extractRes, parseRes] = await Promise.all([
          axios.get(apiUrl, {
            timeout: HTTP_TIMEOUT,
            headers: { 'User-Agent': USER_AGENT },
            params: {
              action: 'query',
              prop: 'extracts',
              exintro: 1,
              explaintext: 1,
              exsentences: 5,
              titles: title,
              format: 'json',
              utf8: 1,
              redirects: 1,
            },
          }),
          axios.get(apiUrl, {
            timeout: HTTP_TIMEOUT,
            headers: { 'User-Agent': USER_AGENT },
            params: {
              action: 'parse',
              page: title,
              prop: 'wikitext',
              section: 0,
              format: 'json',
              redirects: 1,
            },
          }).catch(() => null),
        ]);

        const pages = extractRes.data?.query?.pages;
        const page: any = pages ? Object.values(pages)[0] : null;
        const extract: string = (page?.extract || '').trim();

        let infoboxFacts = '';
        const wikitext: string | undefined = parseRes?.data?.parse?.wikitext?.['*'];
        if (wikitext) infoboxFacts = extractInfoboxFacts(wikitext);

        if (!extract && !infoboxFacts) return null;

        const snippetParts: string[] = [];
        if (infoboxFacts) snippetParts.push(`AKTUELLE FAKTEN (Infobox):\n${infoboxFacts}`);
        if (extract) snippetParts.push(extract.slice(0, 1500));

        return {
          source: 'Wikipedia (de)',
          title,
          snippet: snippetParts.join('\n\n'),
          url: `https://de.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`,
        } as WebSearchResult;
      } catch {
        return null;
      }
    });

    const details = await Promise.all(detailPromises);
    for (const d of details) {
      if (d) out.push(d);
    }
    return out;
  } catch (err) {
    logger.warn('Wikipedia-Suche fehlgeschlagen:', { err: String(err) });
    return out;
  }
}

/**
 * Wikipedia REST-Summary als sehr leichter Fallback (z.B. fuer Begriffe ohne Suchtreffer).
 */
async function wikipediaSummary(title: string): Promise<WebSearchResult | null> {
  try {
    const url = `https://de.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
    const res = await axios.get(url, {
      timeout: HTTP_TIMEOUT,
      headers: { 'User-Agent': USER_AGENT },
      validateStatus: (s) => s < 500,
    });
    if (res.status !== 200) return null;
    const extract: string = res.data?.extract || '';
    if (!extract.trim()) return null;
    return {
      source: 'Wikipedia REST (de)',
      title: res.data?.title || title,
      snippet: extract.slice(0, 1500),
      url: res.data?.content_urls?.desktop?.page,
    };
  } catch {
    return null;
  }
}

/**
 * DuckDuckGo Instant Answer API.
 * Liefert oft kompakte Definitionen / Wikipedia-Abstracts.
 */
async function searchDuckDuckGo(query: string): Promise<WebSearchResult | null> {
  try {
    const res = await axios.get('https://api.duckduckgo.com/', {
      timeout: HTTP_TIMEOUT,
      headers: { 'User-Agent': USER_AGENT },
      params: {
        q: query,
        format: 'json',
        no_html: 1,
        skip_disambig: 1,
        kl: 'de-de',
      },
    });
    const data = res.data;
    const abstract: string = data?.AbstractText || data?.Abstract || '';
    const heading: string = data?.Heading || query;
    const url: string = data?.AbstractURL || '';
    if (!abstract.trim()) return null;
    return {
      source: 'DuckDuckGo',
      title: heading,
      snippet: abstract.slice(0, 1500),
      url: url || undefined,
    };
  } catch (err) {
    logger.warn('DuckDuckGo-Suche fehlgeschlagen:', { err: String(err) });
    return null;
  }
}

/**
 * Heuristik: Lohnt sich eine Live-Suche fuer diese Frage?
 * Bewusst grosszuegig: lieber 1x zu viel suchen als 1x zu wenig.
 * Ausgenommen werden nur reine Smalltalk-/Meta-/Befehlsanfragen.
 */
export function looksFactQuestion(question: string): boolean {
  const q = question.toLowerCase().trim();
  if (q.length < 3) return false;

  // Smalltalk / Meta - keine Suche noetig
  if (/^(hi|hallo|hey|moin|servus|gn8|gn|gute nacht|guten morgen|danke|merci|ok|okay|cool|alles klar|wie geht|na du|jo)\b/.test(q)) return false;
  if (/^(was kannst du|wer bist du|hilfe|help|commands?|befehle)/.test(q)) return false;

  // Reine Mathe-/Code-Fragen brauchen kein Web
  if (/^[\d\s+\-*/()=.,]+$/.test(q)) return false;
  // Code-Fragen ueberspringen die Web-Suche, ABER nur wenn sie keinen
  // Bezug auf API-Versionen / Releases / Jahresangaben haben. Beispiel:
  // "schreib mir code fuer die openai api 2025" muss recherchiert werden,
  // weil sich die API zwischen Trainingsende und heute geaendert haben kann.
  if (/\b(code|programmiere|schreib mir (ein|eine)|implementiere|debug|funktion|class|console\.log)\b/.test(q)) {
    const needsLiveData = /\b(api|sdk|version|release|deprecated|endpoint|2024|2025|2026|2027|aktuell|neueste?n?|breaking change)\b/.test(q);
    if (!needsLiveData) return false;
  }

  // Reine Datum-/Zeit-Fragen werden vom Zeit-Block beantwortet, keine Web-Suche noetig
  if (/^(was f[\u00fcu]r ein tag|welcher tag|welcher wochentag|wie sp[\u00e4a]t|wie viel uhr|wieviel uhr|welches datum|welches jahr|welche jahreszeit)\b/.test(q)) return false;

  // Domain-Themen (Nitrado, FS25, Giants, ModHub, Gameserver, Pterodactyl) immer recherchieren
  if (detectDomainTopics(q).length > 0) return true;

  // Alles andere mit Frage-/Fakten-Charakter \u2192 Web-Suche
  if (/\?$/.test(q)) return true;
  if (/\b(wer|was|wo|wann|wieso|warum|wie viel|wie viele|welche?r?|welches)\b/.test(q)) return true;
  if (/\b(aktuell|derzeit|heute|gerade|momentan|jetzt|neueste?n?|2024|2025|2026|2027)\b/.test(q)) return true;
  if (/\b(bundeskanzler|kanzler|pr\u00e4sident|minister|regierung|wahl|partei|papst|monarch)\b/.test(q)) return true;
  if (/\b(meister|weltmeister|sieger|champion|tabellenf\u00fchrer|saison|spieltag|liga)\b/.test(q)) return true;
  if (/\b(film|serie|spiel|release|version|update|patch|preis|kosten|kurs)\b/.test(q)) return true;
  if (/\b(stadt|land|hauptstadt|einwohner|fluss|gebirge|berg)\b/.test(q)) return true;
  if (/\b(person|geboren|gestorben|biografie|geschichte|erfunden|entdeckt)\b/.test(q)) return true;

  return false;
}

/**
 * Haupt-Einstiegspunkt: Live-Suche nach passenden Quellen.
 * Liefert bis zu 4 Treffer (Wikipedia mehrfach + DDG + REST-Summary-Fallback).
 */
export async function liveSearch(question: string): Promise<WebSearchResult[]> {
  const results: WebSearchResult[] = [];

  // Domain-spezifische Themen erkennen (Nitrado, FS25, Giants, ModHub, ...)
  const topics = detectDomainTopics(question);

  // Parallel suchen, um Latenz zu minimieren
  const wikiTasks: Promise<WebSearchResult[]>[] = [searchWikipedia(question, 3)];
  for (const t of topics) {
    wikiTasks.push(searchWikipedia(t.wikiQuery, 1));
  }

  const [ddg, ...wikiResultGroups] = await Promise.all([
    searchDuckDuckGo(question),
    ...wikiTasks,
  ]);

  for (const group of wikiResultGroups) {
    for (const w of group) {
      if (!results.some((r) => r.url === w.url || r.snippet === w.snippet)) results.push(w);
    }
  }
  if (ddg && !results.some((r) => r.snippet === ddg.snippet)) results.push(ddg);

  // Domain-Wissen als Zusatzquelle: offizielle, vertrauenswuerdige URLs
  for (const t of topics) {
    const lines = t.sources.map((s) => `- ${s.title}: ${s.url} (${s.note})`);
    results.push({
      source: 'Domain-Wissen',
      title: `Vertrauenswuerdige Quellen zu ${t.id.toUpperCase()}`,
      snippet: lines.join('\n'),
    });
  }

  // Fallback: wenn nichts gefunden, REST-Summary fuer die Frage selbst
  if (results.length === 0) {
    const guess = question.replace(/[?.!]/g, '').trim();
    const sum = await wikipediaSummary(guess);
    if (sum) results.push(sum);
  }

  return results;
}

/**
 * Formatiert Suchergebnisse als kompakter System-Prompt-Block.
 */
export function formatSearchResultsForPrompt(results: WebSearchResult[]): string | null {
  if (results.length === 0) return null;
  const blocks = results.map((r, i) => {
    const head = `[Quelle ${i + 1}] ${r.source} \u2013 "${r.title}"${r.url ? `\nURL: ${r.url}` : ''}`;
    return `${head}\n${r.snippet}`;
  });
  return [
    'INTERNE RECHERCHE-DATEN (nicht erwaehnen, nur nutzen):',
    '',
    blocks.join('\n\n---\n\n'),
    '',
    'ANWEISUNGEN:',
    '- Beantworte die Nutzerfrage SELBSTBEWUSST und KONKRET auf Basis dieser Daten.',
    '- Bevorzuge "AKTUELLE FAKTEN (Infobox)"-Werte, wenn vorhanden.',
    '- Erfinde keine Fakten, die nicht in den Daten stehen.',
    '- Erwaehne diese Recherche-Daten NICHT in der Antwort. Sage NICHT "laut Wikipedia", "laut meinen Quellen", "laut meiner Recherche". Antworte einfach direkt mit dem Fakt.',
    '- Halte dich kurz und natuerlich \u2013 keine endlosen Aufzaehlungen.',
  ].join('\n\n');
}
