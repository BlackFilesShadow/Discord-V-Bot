import { wrapUntrustedContext } from './untrustedContext';

/**
 * Prompt-Budget-Manager (Spec §6.D / AI-9).
 *
 * Jeder dynamische Kontext bekommt zuerst ein Quellen-Budget. Danach wird der
 * gesamte Prompt nochmals gegen ein hartes Gesamtbudget geprueft. Pflichtteile
 * (Routing/Security/System/Userfrage und bei DayZ das autoritative Grounding)
 * werden niemals still entfernt. Passt bereits dieser Pflichtkern nicht in das
 * konfigurierte Gesamtbudget, bricht die Assemblierung fail-closed ab.
 */

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export type PromptBudgetKey =
  | 'system'
  | 'knowledge'
  | 'serverContext'
  | 'userContext'
  | 'ragContext'
  | 'history'
  | 'commandContext'
  | 'nitradoContext'
  | 'dayzContext';

export type PromptRole = 'system' | 'user' | 'assistant';

export interface BudgetedPromptPart {
  role: PromptRole;
  content: string;
  source: string;
  /** Hoeher = wichtiger. Bei Gesamt-Ueberlauf fallen niedrige Prioritaeten zuerst weg. */
  priority: number;
  /** Pflichtteile werden nie still entfernt. */
  required?: boolean;
  /** Optionales Quellen-Budget, das vor dem Gesamtbudget angewendet wird. */
  budgetKey?: PromptBudgetKey;
}

export interface PromptMessage {
  role: PromptRole;
  content: string;
}

interface ContextBundleV2 {
  serverContext?: string | null;
  userContext?: string | null;
  ragContext?: string | null;
}

const OUTER_UNTRUSTED_MARKER = 'UNTRUSTED_CONTEXT_DATA_JSON:\n';
const CONTEXT_BUNDLE_MARKER = 'AI_CONTEXT_BUNDLE_V2:\n';
const NITRADO_SECTION_MARKER = 'NITRADO-BEDIENWEG (Hosting-Prozedur, nicht DayZ-Dateisemantik):';
const DAYZ_CONTEXT_MARKERS = [
  'DAYZ 1.29 – GEERDETE ERKLAERBASIS',
  'DAYZ 1.29 – HARTE GROUNDING-REGELN',
  'GEPRUEFTE DAYZ-ENGINE-/SERVER-KONFIGURATION:',
] as const;

/**
 * Zeichen-Budgets pro Kontext-Art. Lazy ausgewertet, damit Tests ENV
 * zur Laufzeit setzen koennen.
 */
export function getPromptBudgets(): Record<PromptBudgetKey, number> {
  return {
    system: envInt('MAX_SYSTEM_CHARS', 6000),
    knowledge: envInt('MAX_KNOWLEDGE_CHARS', 4000),
    serverContext: envInt('MAX_SERVER_CONTEXT_CHARS', 3000),
    userContext: envInt('MAX_USER_CONTEXT_CHARS', 1500),
    ragContext: envInt('MAX_RAG_CONTEXT_CHARS', 3000),
    history: envInt('MAX_HISTORY_CHARS', 4000),
    commandContext: envInt('MAX_COMMAND_CONTEXT_CHARS', 3000),
    nitradoContext: envInt('MAX_NITRADO_CONTEXT_CHARS', 3000),
    dayzContext: envInt('MAX_DAYZ_CONTEXT_CHARS', 4000),
  };
}

/** Gesamtbudget inkl. Systemtexte, Wrapper und aktueller Userfrage. */
export function getTotalPromptBudget(): number {
  return envInt('MAX_TOTAL_PROMPT_CHARS', 32_000);
}

function truncateToLimit(text: string, limit: number): string {
  if (text.length <= limit) return text;
  if (limit <= 0) return '';
  const marker = `\n[… gekuerzt: Budget ${limit} Zeichen erreicht]`;
  if (marker.length >= limit) return text.slice(0, limit);
  const contentLimit = limit - marker.length;
  const slice = text.slice(0, contentLimit);
  const lastBreak = Math.max(slice.lastIndexOf(' '), slice.lastIndexOf('\n'));
  const cut = lastBreak > contentLimit * 0.6 ? slice.slice(0, lastBreak) : slice;
  return `${cut.trimEnd()}${marker}`.slice(0, limit);
}

/**
 * Grounding-Abschnitte behalten ihre kanonische Quellen-/Semantik-Kennung auch
 * bei sehr kleinen Test- oder Betriebsbudgets. Der Body wird innerhalb des
 * verbleibenden Teilbudgets gekappt; falls fuer den langen Standardmarker kein
 * Platz mehr bleibt, zeigt ein kompakter […]-Marker die Kuerzung an.
 */
function truncateSectionPreservingHeader(text: string, header: string, limit: number): string {
  if (text.length <= limit) return text;
  if (limit <= 0) return '';
  if (!text.startsWith(header) || header.length >= limit) return truncateToLimit(text, limit);

  const body = text.slice(header.length).replace(/^\s+/, '');
  const separator = body ? '\n' : '';
  const available = limit - header.length - separator.length;
  if (available <= 0) return header.slice(0, limit);
  if (body.length <= available) return `${header}${separator}${body}`;

  const compactMarker = '[…]';
  if (available <= compactMarker.length) {
    return `${header}${separator}${compactMarker.slice(0, available)}`.slice(0, limit);
  }
  const bodyLimit = available - compactMarker.length;
  return `${header}${separator}${body.slice(0, bodyLimit).trimEnd()}${compactMarker}`.slice(0, limit);
}

function parseContextBundleV2(text: string): { bundle: ContextBundleV2; channelHistory: string | null } | null {
  const markerPos = text.indexOf(OUTER_UNTRUSTED_MARKER);
  if (markerPos < 0) return null;
  const afterMarker = text.slice(markerPos + OUTER_UNTRUSTED_MARKER.length);
  const firstNewline = afterMarker.indexOf('\n');
  const outerJson = (firstNewline >= 0 ? afterMarker.slice(0, firstNewline) : afterMarker).trim();
  const tail = firstNewline >= 0 ? afterMarker.slice(firstNewline).trim() : '';
  try {
    const outer = JSON.parse(outerJson) as { context?: unknown };
    if (typeof outer.context !== 'string' || !outer.context.startsWith(CONTEXT_BUNDLE_MARKER)) return null;
    const inner = JSON.parse(outer.context.slice(CONTEXT_BUNDLE_MARKER.length)) as ContextBundleV2;
    return { bundle: inner, channelHistory: tail || null };
  } catch {
    return null;
  }
}

/**
 * Legacy-Adapter fuer den bestehenden messageCreate -> answerQuestion(context)
 * Vertrag. Der ContextBuilder liefert darin bereits getrennte Felder. Die hier
 * angehaengte rohe Channel-History wird ebenfalls in den untrusted JSON-Block
 * gezogen, statt hinter dem Security-Wrapper als Systemtext stehen zu bleiben.
 */
function clampStructuredContextBundle(text: string): string | null {
  const parsed = parseContextBundleV2(text);
  if (!parsed) return null;
  const budgets = getPromptBudgets();
  const bounded = {
    serverContext: parsed.bundle.serverContext
      ? truncateToLimit(parsed.bundle.serverContext, budgets.serverContext)
      : null,
    userContext: parsed.bundle.userContext
      ? truncateToLimit(parsed.bundle.userContext, budgets.userContext)
      : null,
    ragContext: parsed.bundle.ragContext
      ? truncateToLimit(parsed.bundle.ragContext, budgets.ragContext)
      : null,
    // Persistentes Conversation-Memory wird spaeter separat auf history gekappt.
    // Der fluechtige Discord-Channel-Snapshot bekommt deshalb nur einen Teil
    // desselben Budgets, damit beide Quellen gemeinsam kalkulierbar bleiben.
    channelHistory: parsed.channelHistory
      ? truncateToLimit(parsed.channelHistory, Math.min(1500, budgets.history))
      : null,
  };
  return wrapUntrustedContext(`${CONTEXT_BUNDLE_MARKER}${JSON.stringify(bounded)}`, 20_000);
}

function clampDayzNitradoContext(text: string): string {
  const budgets = getPromptBudgets();
  const hasDayz = DAYZ_CONTEXT_MARKERS.some((marker) => text.includes(marker));
  const nitradoIndex = text.indexOf(NITRADO_SECTION_MARKER);

  if (nitradoIndex >= 0) {
    const beforeNitrado = text.slice(0, nitradoIndex).trim();
    const nitradoAndRules = text.slice(nitradoIndex).trim();
    const parts: string[] = [];
    if (beforeNitrado) {
      const dayzHeader = DAYZ_CONTEXT_MARKERS.find((marker) => beforeNitrado.startsWith(marker));
      const limit = hasDayz ? budgets.dayzContext : budgets.nitradoContext;
      parts.push(dayzHeader
        ? truncateSectionPreservingHeader(beforeNitrado, dayzHeader, limit)
        : truncateToLimit(beforeNitrado, limit));
    }
    if (nitradoAndRules) {
      parts.push(truncateSectionPreservingHeader(
        nitradoAndRules,
        NITRADO_SECTION_MARKER,
        budgets.nitradoContext,
      ));
    }
    return parts.join('\n\n');
  }

  if (hasDayz) {
    const dayzHeader = DAYZ_CONTEXT_MARKERS.find((marker) => text.startsWith(marker));
    if (dayzHeader) return truncateSectionPreservingHeader(text, dayzHeader, budgets.dayzContext);
  }
  return truncateToLimit(text, hasDayz ? budgets.dayzContext : budgets.nitradoContext);
}

/** Kappt einen einzelnen dynamischen Block exakt auf sein Quellen-Budget. */
export function clampBlock(key: PromptBudgetKey, text: string | null | undefined): string | null {
  if (!text) return null;
  if (key === 'serverContext') {
    const structured = clampStructuredContextBundle(text);
    if (structured) return structured;
  }
  if (key === 'nitradoContext') return clampDayzNitradoContext(text);
  return truncateToLimit(text, getPromptBudgets()[key]);
}

/**
 * Kappt eine Verlaufs-Liste auf das gemeinsame History-Budget. Aelteste Turns
 * fallen zuerst weg; ein einzelner zu grosser neuester Turn wird selbst gekappt.
 */
export function clampHistory<T extends { content: string }>(turns: T[]): T[] {
  const limit = getPromptBudgets().history;
  let total = 0;
  const kept: T[] = [];
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    const remaining = limit - total;
    if (remaining <= 0) break;
    if (turn.content.length <= remaining) {
      total += turn.content.length;
      kept.unshift(turn);
      continue;
    }
    if (kept.length === 0) {
      const bounded = truncateToLimit(turn.content, remaining);
      kept.unshift({ ...turn, content: bounded });
      total += bounded.length;
    }
    break;
  }
  return kept;
}

/**
 * Zweite Schutzschicht: Gesamtprompt hart begrenzen. Quellen sind vorher bereits
 * einzeln gekappt. Bei Ueberlauf werden optionale Teile nach Prioritaet und dann
 * in ihrer Original-Reihenfolge entfernt (bei History somit die aeltesten zuerst).
 */
export function composePromptWithinBudget(parts: BudgetedPromptPart[]): PromptMessage[] {
  const prepared = parts
    .map((part, index) => ({
      ...part,
      index,
      content: part.budgetKey ? (clampBlock(part.budgetKey, part.content) ?? '') : part.content,
    }))
    .filter((part) => part.content.length > 0);

  const totalBudget = getTotalPromptBudget();
  const requiredLength = prepared
    .filter((part) => part.required)
    .reduce((sum, part) => sum + part.content.length, 0);
  if (requiredLength > totalBudget) {
    throw new Error(`PROMPT_BUDGET_REQUIRED_OVERFLOW:${requiredLength}/${totalBudget}`);
  }

  let total = prepared.reduce((sum, part) => sum + part.content.length, 0);
  const dropped = new Set<number>();
  if (total > totalBudget) {
    const optional = prepared
      .filter((part) => !part.required)
      .sort((a, b) => a.priority - b.priority || a.index - b.index);
    for (const part of optional) {
      if (total <= totalBudget) break;
      dropped.add(part.index);
      total -= part.content.length;
    }
  }

  if (total > totalBudget) {
    throw new Error(`PROMPT_BUDGET_OVERFLOW:${total}/${totalBudget}`);
  }

  return prepared
    .filter((part) => !dropped.has(part.index))
    .sort((a, b) => a.index - b.index)
    .map(({ role, content }) => ({ role, content }));
}
