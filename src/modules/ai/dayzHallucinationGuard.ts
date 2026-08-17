import { randomUUID } from 'crypto';
import type { KnowledgeSnippet } from './guildKnowledge';
import { looksLikeLiveServerKnowledgeQuestion } from './dayzKnowledgeBoundary';
import { liveServerSourcePrefixForConnection } from './liveServerKnowledgeConstants';

export type LiveFactKind = 'TYPE' | 'EVENT' | 'GLOBAL' | 'CONFIG' | 'JSON';

export interface LiveFactSource {
  sourceRef: string;
  sourceVersion: string | null;
  observedAt: string;
  freshness: string;
}

export interface LiveServerFact {
  key: string;
  kind: LiveFactKind;
  subject: string;
  field: string;
  values: string[];
  sources: LiveFactSource[];
  conflict: boolean;
}

export interface DayzHallucinationGuardBundle {
  version: 1;
  mode: 'LIVE_SERVER';
  scopeStatus: 'RESOLVED' | 'UNRESOLVED';
  nitradoConnId: string | null;
  slot: number | null;
  alias: string | null;
  facts: LiveServerFact[];
  identifiers: string[];
  conflictKeys: string[];
}

export interface GuardPreflightResult {
  handled: boolean;
  response?: string;
}

export interface GuardAnswerValidation {
  valid: boolean;
  violations: string[];
}

const FIELD_HINT_RE = /\b(?:nominal|min|max|lifetime|restock|quantmin|quantmax|cost|value|wert|maxplayers|servertimeacceleration|servernighttimeacceleration|template)\b/i;
const GUARD_PREFIX = 'AI16_GUARD_REF:';
const GUARD_TTL_MS = 2 * 60_000;
const pendingGuards = new Map<string, { expiresAt: number; bundle: DayzHallucinationGuardBundle }>();

function normalize(value: string): string {
  return value.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').trim();
}

function cleanValue(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, '');
}

function addIdentifier(target: Set<string>, value: string): void {
  const clean = cleanValue(value);
  if (!clean || /^-?\d+(?:\.\d+)?$/.test(clean) || /^(?:true|false|null)$/i.test(clean)) return;
  if (/^[A-Za-z][A-Za-z0-9_.+-]{2,120}$/.test(clean)) target.add(clean);
}

function parseLine(line: string): Array<{ kind: LiveFactKind; subject: string; field: string; value: string }> {
  const trimmed = line.trim();
  if (!trimmed || /^LIVE_SERVER\b/i.test(trimmed) || /^deterministic=/i.test(trimmed) || /^status=/i.test(trimmed)) return [];
  if (/^(?:syntaxValid|errors|warnings)=/i.test(trimmed) || /^issue\s/i.test(trimmed)) return [];

  const structured = trimmed.match(/^(type|event|global)=([^|]+)(?:\s*\|\s*(.+))?$/i);
  if (structured) {
    const kind = structured[1].toUpperCase() as 'TYPE' | 'EVENT' | 'GLOBAL';
    const subject = cleanValue(structured[2]);
    const rest = structured[3] ?? '';
    const out: Array<{ kind: LiveFactKind; subject: string; field: string; value: string }> = [];
    for (const part of rest.split(/\s*\|\s*/)) {
      const pair = part.match(/^([A-Za-z0-9_.-]+)=(.*)$/);
      if (!pair) continue;
      const value = cleanValue(pair[2]);
      if (value) out.push({ kind, subject, field: pair[1], value });
    }
    return out;
  }

  const scalar = trimmed.match(/^([A-Za-z][A-Za-z0-9_.\[\]-]{0,180})=(.+)$/);
  if (!scalar) return [];
  const lhs = scalar[1];
  const value = cleanValue(scalar[2]);
  if (!value) return [];
  const isJson = lhs.includes('.') || lhs.includes('[');
  const field = isJson ? (lhs.split('.').pop() ?? lhs).replace(/\[\d+\]$/g, '') : lhs;
  return [{
    kind: isJson ? 'JSON' : 'CONFIG',
    subject: isJson ? lhs : 'serverDZ.cfg',
    field,
    value,
  }];
}

function sourceFor(snippet: KnowledgeSnippet): LiveFactSource | null {
  const p = snippet.provenance;
  if (!p?.sourceRef || p.sourceKind !== 'LIVE_SERVER' || p.trustLevel !== 'VERIFIED' || p.freshness === 'EXPIRED') return null;
  return {
    sourceRef: p.sourceRef,
    sourceVersion: p.sourceVersion,
    observedAt: p.observedAt.toISOString(),
    freshness: p.freshness,
  };
}

export function buildResolvedDayzHallucinationGuard(input: {
  nitradoConnId: string;
  slot: number;
  alias: string;
  snippets: readonly KnowledgeSnippet[];
}): DayzHallucinationGuardBundle {
  const exactPrefix = liveServerSourcePrefixForConnection(input.nitradoConnId);
  const grouped = new Map<string, {
    kind: LiveFactKind;
    subject: string;
    field: string;
    values: Set<string>;
    sources: Map<string, LiveFactSource>;
  }>();
  const identifiers = new Set<string>();

  for (const snippet of input.snippets) {
    const source = sourceFor(snippet);
    if (!source || !source.sourceRef.startsWith(exactPrefix)) continue;
    if (/^LIVE_SERVER VALIDATION\b/i.test(snippet.content.trim())) continue;
    for (const line of snippet.content.split(/\r?\n/)) {
      for (const parsed of parseLine(line)) {
        addIdentifier(identifiers, parsed.subject);
        if (/^(?:children|usage|value|tag|category)$/i.test(parsed.field)) {
          for (const item of parsed.value.split(',')) addIdentifier(identifiers, item);
        }
        const key = `${parsed.kind}:${normalize(parsed.subject)}.${normalize(parsed.field)}`;
        let row = grouped.get(key);
        if (!row) {
          row = {
            kind: parsed.kind,
            subject: parsed.subject,
            field: parsed.field,
            values: new Set<string>(),
            sources: new Map<string, LiveFactSource>(),
          };
          grouped.set(key, row);
        }
        row.values.add(parsed.value);
        row.sources.set(`${source.sourceRef}|${source.sourceVersion ?? ''}`, source);
      }
    }
  }

  const facts: LiveServerFact[] = Array.from(grouped.entries())
    .map(([key, row]) => ({
      key,
      kind: row.kind,
      subject: row.subject,
      field: row.field,
      values: Array.from(row.values).sort(),
      sources: Array.from(row.sources.values()),
      conflict: row.values.size > 1,
    }))
    .sort((a, b) => a.key.localeCompare(b.key));

  return {
    version: 1,
    mode: 'LIVE_SERVER',
    scopeStatus: 'RESOLVED',
    nitradoConnId: input.nitradoConnId,
    slot: input.slot,
    alias: input.alias,
    facts,
    identifiers: Array.from(identifiers).sort((a, b) => a.localeCompare(b)),
    conflictKeys: facts.filter((fact) => fact.conflict).map((fact) => fact.key),
  };
}

export function buildUnresolvedDayzHallucinationGuard(): DayzHallucinationGuardBundle {
  return {
    version: 1,
    mode: 'LIVE_SERVER',
    scopeStatus: 'UNRESOLVED',
    nitradoConnId: null,
    slot: null,
    alias: null,
    facts: [],
    identifiers: [],
    conflictKeys: [],
  };
}

function cleanupRegistry(now = Date.now()): void {
  for (const [id, entry] of pendingGuards) if (entry.expiresAt <= now) pendingGuards.delete(id);
}

/**
 * AI-16 keeps the trusted guard out of UNTRUSTED_CONTEXT_DATA_JSON. Only an
 * unpredictable one-shot reference crosses the existing string API; user or
 * channel text cannot forge a valid bundle.
 */
export function attachHallucinationGuardReference(
  context: string | null,
  bundle: DayzHallucinationGuardBundle | null,
): string | null {
  if (!bundle) return context;
  cleanupRegistry();
  const id = randomUUID();
  pendingGuards.set(id, { expiresAt: Date.now() + GUARD_TTL_MS, bundle });
  return `${GUARD_PREFIX}${id}${context ? `\n${context}` : ''}`;
}

export function consumeHallucinationGuardReference(context: string | undefined): {
  context: string | undefined;
  guard: DayzHallucinationGuardBundle | null;
} {
  if (!context?.startsWith(GUARD_PREFIX)) return { context, guard: null };
  const lineEnd = context.indexOf('\n');
  const id = context.slice(GUARD_PREFIX.length, lineEnd === -1 ? undefined : lineEnd).trim();
  const entry = pendingGuards.get(id);
  pendingGuards.delete(id);
  cleanupRegistry();
  const cleaned = lineEnd === -1 ? undefined : context.slice(lineEnd + 1) || undefined;
  if (!entry || entry.expiresAt <= Date.now()) return { context: cleaned, guard: null };
  return { context: cleaned, guard: entry.bundle };
}

function factsRelevantToQuestion(question: string, guard: DayzHallucinationGuardBundle): LiveServerFact[] {
  const q = normalize(question);
  return guard.facts.filter((fact) => {
    const subject = normalize(fact.subject);
    const field = normalize(fact.field);
    const subjectHit = subject.length >= 3 && q.includes(subject);
    const leaf = normalize(fact.subject.split(/[.\[]/).filter(Boolean).pop() ?? fact.subject);
    const leafHit = leaf.length >= 4 && q.includes(leaf);
    return (subjectHit || leafHit) && (q.includes(field) || !FIELD_HINT_RE.test(q));
  });
}

export function preflightLiveServerQuestion(
  question: string,
  guard: DayzHallucinationGuardBundle | null,
): GuardPreflightResult {
  if (!guard || !looksLikeLiveServerKnowledgeQuestion(question)) return { handled: false };
  if (guard.scopeStatus !== 'RESOLVED') {
    return {
      handled: true,
      response: 'Ich kann die Frage keinem eindeutigen Gameserver zuordnen. Nenne bitte den Slot oder den Server-Alias; ich rate keinen Live-Wert.',
    };
  }

  const relevant = factsRelevantToQuestion(question, guard);
  const conflicts = relevant.filter((fact) => fact.conflict);
  if (conflicts.length > 0) {
    const summary = conflicts.slice(0, 3).map((fact) => `${fact.subject}.${fact.field}: ${fact.values.join(' vs. ')}`).join('; ');
    return {
      handled: true,
      response: `Die verifizierten Live-Daten widersprechen sich (${summary}). Ich nenne deshalb keinen einzelnen Wert, bis der Snapshot eindeutig ist.`,
    };
  }

  if (FIELD_HINT_RE.test(question)) {
    if (relevant.length === 0) {
      return {
        handled: true,
        response: 'Diesen Live-Server-Wert kann ich aus den verifizierten Daten aktuell nicht sicher bestaetigen. Ich ersetze ihn nicht durch einen Vanilla- oder Schaetzwert.',
      };
    }
    if (relevant.length === 1 && relevant[0].values.length === 1) {
      const fact = relevant[0];
      return {
        handled: true,
        response: `Auf dem ausgewaehlten Server ist ${fact.subject}.${fact.field} = ${fact.values[0]}.`,
      };
    }
  }

  if (guard.facts.length === 0) {
    return {
      handled: true,
      response: 'Fuer diesen Gameserver liegen mir aktuell keine verifizierten Live-Fakten zu dieser Frage vor. Ich rate deshalb keinen Wert.',
    };
  }
  return { handled: false };
}

export function formatHallucinationGuardPrompt(guard: DayzHallucinationGuardBundle): string {
  const payload = {
    version: guard.version,
    mode: guard.mode,
    scopeStatus: guard.scopeStatus,
    slot: guard.slot,
    alias: guard.alias,
    facts: guard.facts.slice(0, 120).map((fact) => ({
      kind: fact.kind,
      subject: fact.subject,
      field: fact.field,
      values: fact.values,
      conflict: fact.conflict,
    })),
    identifiers: guard.identifiers.slice(0, 250),
    conflictKeys: guard.conflictKeys,
  };
  return [
    'AI-16 LIVE-SERVER HALLUCINATION GUARD - HARTER SYSTEMVERTRAG:',
    '- Fuer aktuelle Werte/Identifier dieses Gameservers sind ausschliesslich die folgenden VERIFIED LIVE_SERVER-Fakten zulaessig.',
    '- Fehlt ein Wert, sage dass er nicht verifiziert werden kann. Niemals Vanilla-/Trainingswissen als aktuellen Serverwert einsetzen.',
    '- Bei conflict=true oder mehreren Werten fuer denselben Fakt keinen Wert auswaehlen; Konflikt nennen.',
    '- Zahlen und Identifier exakt uebernehmen, nicht runden, erfinden, umbenennen oder aus anderen Servern ableiten.',
    `GUARD_DATA_JSON=${JSON.stringify(payload)}`,
  ].join('\n');
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeComparable(value: string): string {
  return normalize(cleanValue(value)).replace(',', '.');
}

export function validateLiveServerAnswer(
  question: string,
  answer: string,
  guard: DayzHallucinationGuardBundle | null,
): GuardAnswerValidation {
  if (!guard || !looksLikeLiveServerKnowledgeQuestion(question)) return { valid: true, violations: [] };
  const violations: string[] = [];
  if (guard.scopeStatus !== 'RESOLVED') return { valid: false, violations: ['LIVE_SCOPE_UNRESOLVED'] };

  const relevant = factsRelevantToQuestion(question, guard);
  if (relevant.some((fact) => fact.conflict)) violations.push('CONFLICTING_VERIFIED_SOURCES');

  for (const fact of guard.facts) {
    const subjectRe = new RegExp(regexEscape(fact.subject), 'i');
    if (!subjectRe.test(answer)) continue;
    const numericAllowed = fact.values.filter((value) => /^-?\d+(?:[.,]\d+)?$/.test(value));
    if (numericAllowed.length === 0) continue;
    const field = regexEscape(fact.field);
    const claim = new RegExp(`\\b${field}\\b\\s*(?:=|:|ist|liegt\\s+bei|betraegt|beträgt)?\\s*(-?\\d+(?:[.,]\\d+)?)`, 'i').exec(answer);
    if (!claim) continue;
    const asserted = normalizeComparable(claim[1]);
    if (!numericAllowed.some((allowed) => normalizeComparable(allowed) === asserted)) {
      violations.push(`UNSUPPORTED_VALUE:${fact.subject}.${fact.field}=${claim[1]}`);
    }
  }

  const identifierClaims = Array.from(answer.matchAll(/\b(?:type|event|global|classname|class)\s*(?:=|:|ist)?\s*([A-Za-z][A-Za-z0-9_.+-]{2,120})/gi))
    .map((match) => match[1]);
  const allowedIds = new Set(guard.identifiers.map(normalize));
  for (const claimed of identifierClaims) {
    if (!allowedIds.has(normalize(claimed))) violations.push(`UNSUPPORTED_IDENTIFIER:${claimed}`);
  }

  if (FIELD_HINT_RE.test(question) && relevant.length === 0) violations.push('REQUESTED_LIVE_FACT_NOT_VERIFIED');
  return { valid: violations.length === 0, violations: Array.from(new Set(violations)) };
}

export function buildHallucinationGuardFallback(violations: readonly string[]): string {
  if (violations.some((value) => value === 'LIVE_SCOPE_UNRESOLVED')) {
    return 'Ich kann keinen eindeutigen Gameserver bestimmen. Nenne bitte Slot oder Server-Alias; ich rate keine Live-Daten.';
  }
  if (violations.some((value) => value === 'CONFLICTING_VERIFIED_SOURCES')) {
    return 'Die verifizierten Live-Daten widersprechen sich. Ich waehle deshalb keinen Wert aus, bis der Datenstand eindeutig ist.';
  }
  return 'Die erzeugte Antwort enthielt einen Live-Server-Wert oder Identifier, den ich aus den verifizierten Daten nicht sicher belegen kann. Deshalb gebe ich keinen geratenen Wert aus.';
}
