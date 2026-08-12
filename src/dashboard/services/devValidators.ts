/**
 * XML/JSON validators for the DEV area.
 *
 * DayZ-specific rules are grounded against the supplied 1.29 Chernarus,
 * Livonia and Sakhal vanilla data. We validate syntax/shape, but do NOT invent
 * numeric relationships for events.xml that real vanilla data contradicts.
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
  suggestedFix?: string;
}

function offsetToPos(input: string, offset: number): DiagPos {
  let line = 1;
  let column = 1;
  for (let i = 0; i < offset && i < input.length; i++) {
    if (input.charCodeAt(i) === 10) { line += 1; column = 1; } else column += 1;
  }
  return { line, column, offset };
}

// --- JSON -----------------------------------------------------------------

const JSON_POS_RE = /position\s+(\d+)/i;
const JSON_LINE_COL_RE = /line\s+(\d+)\s+column\s+(\d+)/i;

function tryAutofixJson(input: string): string | undefined {
  let s = input;
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  s = s.replace(/,(\s*[}\]])/g, '$1');
  if (!s.includes('"') && s.includes("'")) s = s.replace(/'/g, '"');
  s = s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  s = s.replace(/,\s*,/g, ',');
  if (s === input) return undefined;
  try { JSON.parse(s); return s; } catch { return undefined; }
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
    if (lc) pos = { line: parseInt(lc[1], 10), column: parseInt(lc[2], 10), offset: 0 };
    else {
      const p = JSON_POS_RE.exec(msg);
      if (p) pos = offsetToPos(input, parseInt(p[1], 10));
    }
    const fix = tryAutofixJson(input);
    return {
      ok: false,
      issues: [{ severity: 'error', message: msg, pos, hint: fix ? 'Auto-Fix verfuegbar (siehe suggestedFix).' : 'Pruefe Kommas, Quotes und schliessende Klammern.' }],
      suggestedFix: fix,
    };
  }
}

// --- XML ------------------------------------------------------------------

interface XmlState { stack: string[]; issues: DiagIssue[]; }

function pushIssue(state: XmlState, input: string, offset: number, message: string, hint?: string): void {
  state.issues.push({ severity: 'error', message, pos: offsetToPos(input, offset), hint });
}

/**
 * Lightweight tolerant XML validator.
 *
 * Comment content is deliberately treated as opaque until "-->". Bohemia's
 * own DZ_129 cfgspawnabletypes.xml contains decorative comments with internal
 * "--" sequences that strict W3C parsers can reject although they occur in the
 * official DayZ mission data.
 */
export function validateXml(input: string): ValidatorResult {
  if (input.trim().length === 0) {
    return { ok: false, issues: [{ severity: 'error', message: 'Leere Eingabe.', pos: { line: 1, column: 1, offset: 0 } }] };
  }

  const state: XmlState = { stack: [], issues: [] };
  let i = 0;
  let rootSeen = false;
  while (i < input.length) {
    if (input[i] !== '<') { i += 1; continue; }

    if (input.startsWith('<!--', i)) {
      const end = input.indexOf('-->', i + 4);
      if (end < 0) { pushIssue(state, input, i, 'Kommentar nicht geschlossen.'); break; }
      i = end + 3;
      continue;
    }
    if (input.startsWith('<![CDATA[', i)) {
      const end = input.indexOf(']]>', i + 9);
      if (end < 0) { pushIssue(state, input, i, 'CDATA nicht geschlossen.'); break; }
      i = end + 3;
      continue;
    }
    if (input.startsWith('<?', i) || input.startsWith('<!', i)) {
      const end = input.indexOf('>', i);
      if (end < 0) { pushIssue(state, input, i, 'Processing-Instruktion nicht geschlossen.'); break; }
      i = end + 1;
      continue;
    }

    if (input[i + 1] === '/') {
      const end = input.indexOf('>', i + 2);
      if (end < 0) { pushIssue(state, input, i, 'Schliessendes Tag nicht beendet.'); break; }
      const name = input.slice(i + 2, end).trim();
      const top = state.stack.pop();
      if (!top) pushIssue(state, input, i, `Schliessendes Tag </${name}> ohne Oeffnung.`);
      else if (top !== name) {
        pushIssue(state, input, i, `Falsche Verschachtelung: erwartet </${top}>, gefunden </${name}>.`);
        state.stack.push(top);
      }
      i = end + 1;
      continue;
    }

    const end = input.indexOf('>', i);
    if (end < 0) { pushIssue(state, input, i, 'Tag nicht geschlossen ("<" ohne ">").'); break; }
    const inner = input.slice(i + 1, end);
    const selfClosing = /\/\s*$/.test(inner);
    const body = selfClosing ? inner.replace(/\/\s*$/, '') : inner;
    const nameMatch = /^([A-Za-z_][\w.:-]*)/.exec(body.trim());
    if (!nameMatch) {
      pushIssue(state, input, i, 'Tag-Name fehlt oder ungueltig.');
      i = end + 1;
      continue;
    }

    const name = nameMatch[1];
    const attrs = body.slice(body.indexOf(name) + name.length);
    const attrRe = /\s+([A-Za-z_][\w.:-]*)\s*(=\s*("[^"]*"|'[^']*'|([^\s/>]+)))?/g;
    let am: RegExpExecArray | null;
    while ((am = attrRe.exec(attrs)) !== null) {
      if (am[2] && am[4]) pushIssue(state, input, i + am.index, `Attribut "${am[1]}" hat keinen Quote-Wert.`, `Setze Quotes: ${am[1]}="..."`);
    }
    rootSeen = true;
    if (!selfClosing) state.stack.push(name);
    i = end + 1;
  }

  if (state.stack.length > 0) {
    const missing = [...state.stack].reverse();
    pushIssue(state, input, input.length, `Unbalancierte Tags am Ende: ${missing.join(', ')}`, 'Schliesse fehlende Tags in umgekehrter Reihenfolge.');
  }
  if (!rootSeen) pushIssue(state, input, 0, 'Kein Root-Element gefunden.');
  return { ok: state.issues.length === 0, issues: state.issues };
}

// --- DayZ structural validation -------------------------------------------

export type DayzXmlKind = 'types' | 'events' | 'globals' | 'generic';

export function detectDayzXmlKind(input: string, fileName?: string): DayzXmlKind {
  const fn = (fileName ?? '').toLowerCase();
  if (fn.includes('types')) return 'types';
  if (fn.includes('events') && !fn.includes('cfgeventspawns')) return 'events';
  if (fn.includes('globals')) return 'globals';
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
 * Grounded DayZ structural checks.
 *
 * types.xml: validates required numeric fields, non-negative values and names.
 * `min == nominal` is explicitly valid. `min > nominal` is flagged because it
 * occurs zero times in all three supplied 1.29 vanilla files.
 *
 * events.xml: validates names and numeric shape only. There is deliberately NO
 * min/max/nominal ordering rule: real 1.29 vanilla events contain nominal>max,
 * min>max and nominal<min combinations depending on event semantics.
 */
export function validateDayzXml(input: string, fileName?: string): ValidatorResult & { kind: DayzXmlKind } {
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
      for (const [field, value] of [['nominal', nominal], ['min', min], ['lifetime', lifetime]] as const) {
        if (value === null) issues.push({ severity: 'warning', message: `type "${name}": <${field}> fehlt oder ist keine Zahl.`, pos: at });
        else if (value < 0) issues.push({ severity: 'error', message: `type "${name}": <${field}> ist negativ (${value}).`, pos: at });
      }
      if (restock !== null && restock < 0) issues.push({ severity: 'error', message: `type "${name}": <restock> ist negativ (${restock}).`, pos: at });
      if (nominal !== null && min !== null && min > nominal) {
        issues.push({ severity: 'error', message: `type "${name}": min (${min}) > nominal (${nominal}).`, pos: at, hint: 'In den drei geprueften Vanilla-1.29-Datensaetzen kommt min > nominal nicht vor; pruefe den Eintrag.' });
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
      for (const field of ['nominal', 'min', 'max', 'lifetime', 'restock'] as const) {
        const raw = ev[field];
        if (raw === undefined) continue;
        const value = num(raw);
        if (value === null) issues.push({ severity: 'warning', message: `event "${name}": <${field}> ist keine Zahl.`, pos: at });
        else if (value < 0) issues.push({ severity: 'error', message: `event "${name}": <${field}> ist negativ (${value}).`, pos: at });
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
      if (v['@_value'] === undefined || v['@_value'] === '') issues.push({ severity: 'error', message: `var "${name}": value fehlt.`, pos: at });
      else if (num(v['@_value']) === null) issues.push({ severity: 'warning', message: `var "${name}": value ist keine gueltige Zahl ("${String(v['@_value'])}").`, pos: at });
    }
  }

  return { ok: issues.length === 0, kind, issues };
}
