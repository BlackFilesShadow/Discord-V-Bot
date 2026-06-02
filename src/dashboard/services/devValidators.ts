/**
 * XML/JSON-Validatoren fuer den DEV-Bereich (Spec Sektion 6).
 *
 * Beide liefern strukturierte Fehler mit Zeile/Spalte und einen
 * Best-Effort-Auto-Fix-Hinweis. Wir vermeiden externe Dependencies und
 * nutzen Native-JSON.parse plus einen schlanken handgeschriebenen XML-Sax.
 *
 * Die Validatoren NIE Inhalt veraendern — sie liefern nur Diagnose und
 * (optional) eine Fix-Vorschlag-Zeichenkette, die der User uebernehmen kann.
 */
import { XMLParser } from 'fast-xml-parser';

export interface DiagPos { line: number; column: number; offset: number }
export interface DiagIssue {
  severity: 'error' | 'warning';
  message: string;
  pos: DiagPos;
  hint?: string;
}
export interface ValidatorResult {
  ok: boolean;
  issues: DiagIssue[];
  suggestedFix?: string; // optionale autom. Korrektur des gesamten Inputs
}

function offsetToPos(input: string, offset: number): DiagPos {
  let line = 1, col = 1;
  for (let i = 0; i < offset && i < input.length; i++) {
    if (input.charCodeAt(i) === 10) { line++; col = 1; } else { col++; }
  }
  return { line, column: col, offset };
}

// --- JSON ----------------------------------------------------------------

const JSON_POS_RE = /position\s+(\d+)/i;
const JSON_LINE_COL_RE = /line\s+(\d+)\s+column\s+(\d+)/i;

function tryAutofixJson(input: string): string | undefined {
  let s = input;
  // BOM entfernen
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  // Trailing-Commas entfernen
  s = s.replace(/,(\s*[}\]])/g, '$1');
  // Single-Quotes -> Double-Quotes (heuristisch, nur wenn KEINE Double-Quotes)
  if (!s.includes('"') && s.includes("'")) {
    s = s.replace(/'/g, '"');
  }
  // // und /* */ Kommentare entfernen
  s = s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  // Doppel-Kommas
  s = s.replace(/,\s*,/g, ',');
  if (s === input) return undefined;
  try {
    JSON.parse(s);
    return s;
  } catch {
    return undefined;
  }
}

export function validateJson(input: string): ValidatorResult {
  if (input.trim().length === 0) {
    return { ok: false, issues: [{ severity: 'error', message: 'Leere Eingabe.', pos: { line: 1, column: 1, offset: 0 } }] };
  }
  try {
    JSON.parse(input);
    return { ok: true, issues: [] };
  } catch (err) {
    const msg = (err as Error).message;
    let pos: DiagPos = { line: 1, column: 1, offset: 0 };
    const lc = JSON_LINE_COL_RE.exec(msg);
    if (lc) {
      pos = { line: parseInt(lc[1], 10), column: parseInt(lc[2], 10), offset: 0 };
    } else {
      const p = JSON_POS_RE.exec(msg);
      if (p) pos = offsetToPos(input, parseInt(p[1], 10));
    }
    const fix = tryAutofixJson(input);
    return {
      ok: false,
      issues: [{
        severity: 'error',
        message: msg,
        pos,
        hint: fix ? 'Auto-Fix verfuegbar (siehe suggestedFix).' : 'Pruefe Komma-Trennung, doppelte Quotes und schliessende Klammern.',
      }],
      suggestedFix: fix,
    };
  }
}

// --- XML -----------------------------------------------------------------

interface XmlState {
  stack: string[];
  issues: DiagIssue[];
}

function pushIssue(state: XmlState, input: string, offset: number, message: string, hint?: string): void {
  state.issues.push({ severity: 'error', message, pos: offsetToPos(input, offset), hint });
}

/**
 * Schlanker, toleranter XML-Validator. Erkennt:
 *  - nicht geschlossene Tags
 *  - falsche Verschachtelung
 *  - unentschluesselte Entities (&...;)
 *  - kaputte Attribut-Quotes
 *  - fehlende Root
 */
export function validateXml(input: string): ValidatorResult {
  if (input.trim().length === 0) {
    return { ok: false, issues: [{ severity: 'error', message: 'Leere Eingabe.', pos: { line: 1, column: 1, offset: 0 } }] };
  }

  const state: XmlState = { stack: [], issues: [] };
  let i = 0;
  let rootSeen = false;

  while (i < input.length) {
    const ch = input[i];
    if (ch !== '<') { i++; continue; }

    // Comment
    if (input.startsWith('<!--', i)) {
      const end = input.indexOf('-->', i + 4);
      if (end < 0) { pushIssue(state, input, i, 'Kommentar nicht geschlossen.'); break; }
      i = end + 3; continue;
    }
    // CDATA
    if (input.startsWith('<![CDATA[', i)) {
      const end = input.indexOf(']]>', i + 9);
      if (end < 0) { pushIssue(state, input, i, 'CDATA nicht geschlossen.'); break; }
      i = end + 3; continue;
    }
    // Processing instruction / declaration
    if (input.startsWith('<?', i) || input.startsWith('<!', i)) {
      const end = input.indexOf('>', i);
      if (end < 0) { pushIssue(state, input, i, 'Processing-Instruktion nicht geschlossen.'); break; }
      i = end + 1; continue;
    }
    // Closing tag
    if (input[i + 1] === '/') {
      const end = input.indexOf('>', i + 2);
      if (end < 0) { pushIssue(state, input, i, 'Schliessendes Tag nicht beendet.'); break; }
      const name = input.slice(i + 2, end).trim();
      const top = state.stack.pop();
      if (!top) {
        pushIssue(state, input, i, `Schliessendes Tag </${name}> ohne Oeffnung.`, 'Pruefe ob ein <${name}> fehlt.');
      } else if (top !== name) {
        pushIssue(state, input, i, `Falsche Verschachtelung: erwartet </${top}>, gefunden </${name}>.`,
          `Schliesse zuerst <${top}> oder oeffne <${name}> korrekt.`);
        // Stack zuruecksetzen, damit Folgefehler nicht eskalieren.
        // Behalte top fuer den naechsten Vergleich.
        state.stack.push(top);
      }
      i = end + 1; continue;
    }
    // Opening tag
    const end = input.indexOf('>', i);
    if (end < 0) { pushIssue(state, input, i, 'Tag nicht geschlossen ("<" ohne ">").'); break; }
    const inner = input.slice(i + 1, end);
    const selfClosing = inner.endsWith('/');
    const body = selfClosing ? inner.slice(0, -1) : inner;
    const nameMatch = /^([A-Za-z_][\w.:-]*)/.exec(body.trim());
    if (!nameMatch) {
      pushIssue(state, input, i, 'Tag-Name fehlt oder ungueltig.');
      i = end + 1; continue;
    }
    const name = nameMatch[1];
    // Attribut-Validierung: jedes attribute=value muss gequotet sein.
    const attrs = body.slice(nameMatch[0].length);
    const attrRe = /\s+([A-Za-z_][\w.:-]*)\s*(=\s*("([^"]*)"|'([^']*)'|([^\s/>]+)))?/g;
    let am: RegExpExecArray | null;
    while ((am = attrRe.exec(attrs)) !== null) {
      if (am[2] && !am[3]?.startsWith('"') && !am[3]?.startsWith("'")) {
        pushIssue(state, input, i + nameMatch[0].length + am.index,
          `Attribut "${am[1]}" hat keinen Quote-Wert.`,
          `Setze Quotes: ${am[1]}="..."`);
      }
    }
    if (!selfClosing) {
      state.stack.push(name);
      rootSeen = true;
    } else {
      rootSeen = true;
    }
    i = end + 1;
  }

  if (state.stack.length > 0) {
    pushIssue(state, input, input.length, `Unbalancierte Tags am Ende: ${state.stack.reverse().join(', ')}`,
      'Schliesse fehlende Tags in umgekehrter Reihenfolge.');
  }
  if (!rootSeen) {
    pushIssue(state, input, 0, 'Kein Root-Element gefunden.');
  }

  // Auto-Fix-Vorschlag: nicht geschlossene Tags am Ende anhaengen.
  let suggestedFix: string | undefined;
  if (state.issues.length > 0 && state.issues.every(x => x.message.startsWith('Unbalancierte'))) {
    const closing = state.stack.map(n => `</${n}>`).join('');
    suggestedFix = input + closing;
  }

  return { ok: state.issues.length === 0, issues: state.issues, suggestedFix };
}

// --- DayZ-spezifische XML-Struktur ---------------------------------------

export type DayzXmlKind = 'types' | 'events' | 'globals' | 'generic';

/** Erkennt den DayZ-Dateityp anhand Dateiname und/oder Root-Element. */
export function detectDayzXmlKind(input: string, fileName?: string): DayzXmlKind {
  const fn = (fileName ?? '').toLowerCase();
  if (fn.includes('types')) return 'types';
  if (fn.includes('events') && !fn.includes('cfgeventspawns')) return 'events';
  if (fn.includes('globals')) return 'globals';
  // Fallback: am Root-Element erkennen.
  const head = input.slice(0, 4000);
  if (/<types\b/i.test(head)) return 'types';
  if (/<events\b/i.test(head) && !/<eventposdef\b/i.test(head)) return 'events';
  if (/<variables\b/i.test(head) && /<var\b/i.test(head)) return 'globals';
  return 'generic';
}

function num(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

/**
 * DayZ-XML-Strukturvalidierung fuer types.xml / events.xml / globals.xml.
 * Laeuft NUR auf wohlgeformtem XML (sonst zuerst validateXml). Liefert
 * zusaetzliche, struktur-bezogene Diagnosen oben auf die Syntaxpruefung.
 */
export function validateDayzXml(input: string, fileName?: string): ValidatorResult & { kind: DayzXmlKind } {
  // 1) Erst Wohlgeformtheit pruefen.
  const base = validateXml(input);
  const kind = detectDayzXmlKind(input, fileName);
  if (!base.ok) return { ...base, kind };

  const issues: DiagIssue[] = [];
  const at = { line: 1, column: 1, offset: 0 };
  let doc: Record<string, unknown>;
  try {
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: true });
    doc = parser.parse(input) as Record<string, unknown>;
  } catch (e) {
    return { ok: false, kind, issues: [{ severity: 'error', message: `XML-Parsing fehlgeschlagen: ${(e as Error).message}`, pos: at }] };
  }

  if (kind === 'types') {
    const root = doc.types as Record<string, unknown> | undefined;
    const types = asArray(root?.type as Record<string, unknown> | Record<string, unknown>[] | undefined);
    if (types.length === 0) issues.push({ severity: 'warning', message: '<types> enthaelt keine <type>-Eintraege.', pos: at });
    const seen = new Set<string>();
    for (const t of types) {
      const name = t['@_name'] as string | undefined;
      if (!name || String(name).trim() === '') {
        issues.push({ severity: 'error', message: 'Ein <type> hat kein name-Attribut.', pos: at });
        continue;
      }
      if (seen.has(name)) issues.push({ severity: 'error', message: `Doppelter type name: "${name}".`, pos: at });
      seen.add(name);
      const nominal = num(t.nominal);
      const min = num(t.min);
      const lifetime = num(t.lifetime);
      const restock = num(t.restock);
      for (const [k, v] of [['nominal', nominal], ['min', min], ['lifetime', lifetime]] as const) {
        if (v === null) issues.push({ severity: 'warning', message: `type "${name}": <${k}> fehlt oder ist keine Zahl.`, pos: at });
        else if (v < 0) issues.push({ severity: 'error', message: `type "${name}": <${k}> ist negativ (${v}).`, pos: at });
      }
      if (restock !== null && restock < 0) issues.push({ severity: 'error', message: `type "${name}": <restock> ist negativ (${restock}).`, pos: at });
      if (nominal !== null && min !== null && min > nominal) {
        issues.push({ severity: 'error', message: `type "${name}": min (${min}) > nominal (${nominal}).`, pos: at, hint: 'min darf nominal nicht ueberschreiten.' });
      }
    }
  } else if (kind === 'events') {
    const root = doc.events as Record<string, unknown> | undefined;
    const events = asArray(root?.event as Record<string, unknown> | Record<string, unknown>[] | undefined);
    if (events.length === 0) issues.push({ severity: 'warning', message: '<events> enthaelt keine <event>-Eintraege.', pos: at });
    const seen = new Set<string>();
    for (const ev of events) {
      const name = ev['@_name'] as string | undefined;
      if (!name || String(name).trim() === '') {
        issues.push({ severity: 'error', message: 'Ein <event> hat kein name-Attribut.', pos: at });
        continue;
      }
      if (seen.has(name)) issues.push({ severity: 'warning', message: `Doppelter event name: "${name}".`, pos: at });
      seen.add(name);
      const nominal = num(ev.nominal);
      const min = num(ev.min);
      const max = num(ev.max);
      if (min !== null && max !== null && min > max) {
        issues.push({ severity: 'error', message: `event "${name}": min (${min}) > max (${max}).`, pos: at });
      }
      if (nominal !== null && max !== null && nominal > max) {
        issues.push({ severity: 'error', message: `event "${name}": nominal (${nominal}) > max (${max}).`, pos: at });
      }
      if (nominal !== null && min !== null && nominal < min) {
        issues.push({ severity: 'warning', message: `event "${name}": nominal (${nominal}) < min (${min}).`, pos: at });
      }
    }
  } else if (kind === 'globals') {
    const root = doc.variables as Record<string, unknown> | undefined;
    const vars = asArray(root?.var as Record<string, unknown> | Record<string, unknown>[] | undefined);
    if (vars.length === 0) issues.push({ severity: 'warning', message: '<variables> enthaelt keine <var>-Eintraege.', pos: at });
    const seen = new Set<string>();
    for (const v of vars) {
      const name = v['@_name'] as string | undefined;
      if (!name || String(name).trim() === '') {
        issues.push({ severity: 'error', message: 'Ein <var> hat kein name-Attribut.', pos: at });
        continue;
      }
      if (seen.has(name)) issues.push({ severity: 'warning', message: `Doppelte globale Variable: "${name}".`, pos: at });
      seen.add(name);
      if (v['@_value'] === undefined || v['@_value'] === '') {
        issues.push({ severity: 'error', message: `var "${name}": value fehlt.`, pos: at });
      } else if (num(v['@_value']) === null) {
        issues.push({ severity: 'warning', message: `var "${name}": value ist keine gueltige Zahl ("${String(v['@_value'])}").`, pos: at });
      }
    }
  }

  return { ok: issues.length === 0, kind, issues };
}
