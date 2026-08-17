/**
 * AI-13: Reine, DB-freie Klassifikation fuer die harte Wissensdomain-Grenze.
 *
 * GENERAL_DAYZ = Vanilla/Version/Dateisemantik/allgemeine Referenz und
 * deterministische How-to-/Konfigurationsanleitungen.
 * LIVE_SERVER = reale aktuelle Werte bzw. Zustand eines konkreten verbundenen
 * Gameservers.
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

// NFKD normalisiert echte Umlaute ("ändere" -> "andere"), aber nicht die in
// Chats haeufige ASCII-Schreibweise ae/oe/ue. Beide Formen muessen als How-to
// erkannt werden, sonst kann z. B. "Wie aendere ich die Map auf meinem Server?"
// faelschlich als Anfrage nach dem aktuellen Live-Server-Zustand gelten.
const MUTATION_HOW_TO_RE = /\b(?:installiere|installieren|erhohe|erhohen|erhoehe|erhoehen|reduziere|reduzieren|senke|senken|andern|aendere|aendern|konfiguriere|konfigurieren|einrichten|richte|aktiviere|aktivieren|deaktiviere|deaktivieren|setze|setzen|fuge|fuege|hinzufugen|hinzufuegen|entferne|entfernen|bearbeite|bearbeiten|passe|anpassen)\b/;
const CHANGE_I_RE = /\b(?:wie\s+)?(?:andere|aendere)\s+ich\b/;

const EXPLICIT_SERVER_RE = /\b(?:bei uns|unser(?:em|er|e|en)?\s+(?:dayz\s+)?(?:server|gameserver)|mein(?:em|er|e|en)?\s+(?:dayz\s+)?(?:server|gameserver)|dies(?:em|er|e|en)?\s+(?:dayz\s+)?(?:server|gameserver)|(?:der\s+)?aktuelle(?:n|r|s)?\s+(?:dayz\s+)?(?:server|gameserver)|live\s+(?:server|gameserver))\b/;
const EXPLICIT_SLOT_RE = /\b(?:slot|server|gameserver)\s*[1-4]\b/;

const CURRENT_STATE_RE = /\b(?:ist|sind|hat|haben|gilt|gelten|aktuell|derzeit|momentan|status|eingestellt|einstellung|einstellungen|konfiguration|config|wert|werte|nominal|min|max|lifetime|restock|restart|restartzeit|map|karte|mission)\b/;

const POSSESSIVE_RUNTIME_RE = /\b(?:unser|unsere|unseren|unserem|meine|meinen|meinem)\s+(?:restart|restartzeit|einstellung|einstellungen|konfiguration|config|nominal|min|max|lifetime|restock|map|karte|mission|serverstatus|gameserverstatus)\b/;

/**
 * True bedeutet nicht "die Frage handelt irgendwie vom eigenen Server", sondern
 * enger: Die Antwort benoetigt den tatsaechlichen aktuellen Serverzustand.
 *
 * Aenderungs-/How-to-Fragen wie "Wie installiere ich Mods auf meinem Server?"
 * oder "Wie erhoehe ich den Loot?" bleiben GENERAL_DAYZ. So koennen die bereits
 * geerdeten deterministischen Anleitungen greifen, ohne Vanilla-Werte als
 * aktuellen Live-Zustand auszugeben.
 */
export function looksLikeLiveServerKnowledgeQuestion(question: string): boolean {
  const q = normalizeBoundaryText(question);
  if (!q) return false;
  if (MUTATION_HOW_TO_RE.test(q) || CHANGE_I_RE.test(q)) return false;
  if (POSSESSIVE_RUNTIME_RE.test(q)) return true;
  if (EXPLICIT_SLOT_RE.test(q) && CURRENT_STATE_RE.test(q)) return true;
  return EXPLICIT_SERVER_RE.test(q) && CURRENT_STATE_RE.test(q);
}
