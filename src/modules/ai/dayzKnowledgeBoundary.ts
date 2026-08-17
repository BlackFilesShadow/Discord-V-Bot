/**
 * AI-13: Reine, DB-freie Klassifikation fuer die harte Wissensdomain-Grenze.
 *
 * GENERAL_DAYZ = Vanilla/Version/Dateisemantik/allgemeine Referenz.
 * LIVE_SERVER = reale Konfiguration bzw. aktueller Zustand eines konkreten
 * verbundenen Gameservers.
 */

function normalizeBoundaryText(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function looksLikeLiveServerKnowledgeQuestion(question: string): boolean {
  const q = normalizeBoundaryText(question);
  if (!q) return false;
  return /\b(?:bei uns|unser server|unser gameserver|mein server|mein gameserver|dieser server|dieser gameserver|aktueller server|aktueller gameserver|live server|live gameserver)\b/.test(q)
    || /\b(?:auf|von|bei)\s+(?:unserem|meinem|diesem|dem aktuellen)\s+(?:dayz\s+)?(?:server|gameserver)\b/.test(q)
    || /\b(?:wie|was|welche|welcher|welches|wieviel|wie viel)\b.*\b(?:bei uns|auf unserem|auf meinem|auf diesem)\b/.test(q);
}
