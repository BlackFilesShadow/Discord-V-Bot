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

/** Kappt einen einzelnen dynamischen Block exakt auf sein Quellen-Budget. */
export function clampBlock(key: PromptBudgetKey, text: string | null | undefined): string | null {
  if (!text) return null;
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
