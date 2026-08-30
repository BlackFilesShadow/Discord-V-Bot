/**
 * Provider-unabhaengige Antworten fuer reine Gespraechsoeffner.
 *
 * Ein isoliertes "hey" oder "ich habe eine Frage" benoetigt weder das grosse
 * System-Prompt noch einen externen Provider. Das spart Provider-Quota und
 * verhindert, dass ein vorheriger Reply-Kontext aus einer Begruessung
 * versehentlich eine sachfremde Antwort (z. B. erneut die Uhrzeit) macht.
 * Inhaltliche Nachrichten werden absichtlich nie abgefangen.
 */

function normalize(value: string): string {
  return String(value || '')
    .toLocaleLowerCase('de-DE')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[-–—?!.,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const GREETINGS = new Set([
  'hi',
  'hallo',
  'hey',
  'moin',
  'servus',
  'na',
  'na du',
  'guten morgen',
  'guten tag',
  'guten abend',
]);

const QUESTION_OPENERS = new Set([
  'ich hab eine frage',
  'ich habe eine frage',
  'ich hab ne frage',
  'ich habe ne frage',
  'hab eine frage',
  'habe eine frage',
  'hab ne frage',
  'kann ich dich was fragen',
  'kann ich etwas fragen',
  'darf ich was fragen',
  'darf ich etwas fragen',
]);

export function answerLocalConversationTurn(question: string): string | null {
  const normalized = normalize(question);
  if (GREETINGS.has(normalized)) return 'Hey! Was kann ich für dich tun?';
  if (QUESTION_OPENERS.has(normalized)) return 'Klar – stell deine Frage einfach.';
  return null;
}
