/**
 * Prompt-Budget-Manager (Spec §6.D).
 *
 * Verhindert unnoetig lange Prompts, indem jeder Kontext-Block VOR der
 * Assemblierung auf ein konfigurierbares Zeichen-Budget gekappt wird.
 * So vermischen sich Server-/User-/General-/Knowledge-Kontexte nicht zu einem
 * aufgeblaehten System-Prompt und die Token-Kosten/Latenz bleiben kalkulierbar.
 *
 * Alle Budgets sind per ENV uebersteuerbar; die Defaults sind grosszuegig
 * gewaehlt, damit bestehendes Verhalten nicht beschnitten wird, solange die
 * Bloecke unter dem Default liegen.
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
  | 'history'
  | 'commandContext'
  | 'nitradoContext';

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
    history: envInt('MAX_HISTORY_CHARS', 4000),
    commandContext: envInt('MAX_COMMAND_CONTEXT_CHARS', 3000),
    nitradoContext: envInt('MAX_NITRADO_CONTEXT_CHARS', 3000),
  };
}

/**
 * Kappt einen einzelnen Block auf das Budget der angegebenen Kategorie.
 * Schneidet an einer Wortgrenze ab und haengt einen klaren Truncation-Marker an,
 * damit die LLM erkennt, dass der Block gekuerzt wurde (statt mitten im Satz zu enden).
 */
export function clampBlock(key: PromptBudgetKey, text: string | null | undefined): string | null {
  if (!text) return null;
  const limit = getPromptBudgets()[key];
  if (text.length <= limit) return text;
  // An letzter Wortgrenze unterhalb des Limits schneiden.
  const slice = text.slice(0, limit);
  const lastBreak = Math.max(slice.lastIndexOf(' '), slice.lastIndexOf('\n'));
  const cut = lastBreak > limit * 0.6 ? slice.slice(0, lastBreak) : slice;
  return `${cut.trimEnd()}\n[… gekuerzt: Budget ${limit} Zeichen erreicht]`;
}

/**
 * Kappt eine Verlaufs-Liste (role/content) so, dass die Summe der Inhalte
 * unter dem History-Budget bleibt. Aelteste Turns werden zuerst verworfen,
 * juengste bleiben erhalten (sie sind fuer den aktuellen Kontext relevanter).
 */
export function clampHistory<T extends { content: string }>(turns: T[]): T[] {
  const limit = getPromptBudgets().history;
  let total = 0;
  const kept: T[] = [];
  for (let i = turns.length - 1; i >= 0; i--) {
    const len = turns[i].content.length;
    if (total + len > limit && kept.length > 0) break;
    total += len;
    kept.unshift(turns[i]);
  }
  return kept;
}
