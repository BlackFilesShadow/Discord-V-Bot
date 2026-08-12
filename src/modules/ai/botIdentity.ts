// Autoritative, serverunabhaengige Identitaet von V-Bot.
//
// WICHTIG: Discord-Guild-Owner, Server-Owner, Admins oder Rollen sind KEINE
// Quelle fuer die Entwickler-Identitaet. Diese Information ist absichtlich
// statisch, damit ein Owner-Wechsel niemals als Entwickler-Wechsel interpretiert
// werden kann.
export const BOT_DEVELOPER = 'Void_Architect' as const;

const DEVELOPER_TERMS = '(?:entwickler(?:in)?|developer|programmierer(?:in)?|ersteller(?:in)?|erschaffer(?:in)?|sch[oö]pfer(?:in)?|creator)';
const CREATION_VERBS = '(?:gebaut|erschaffen|erstellt|programmiert|gemacht|entwickelt|gecodet|created|developed|programmed|built)';
const VBOT = 'v[-_ ]?bot(?:\\s+prime)?';

/**
 * Kompakter Regex fuer den globalen statischen Discord-Trigger.
 *
 * GLOBAL_AI_TRIGGERS wird ueber safeRegexTest ausgewertet. Dort gilt bewusst
 * ein 200-Zeichen-Limit fuer Regex-Patterns. Deshalb bleibt dieser Trigger
 * kompakt und serverunabhaengig, ohne den globalen ReDoS-Schutz aufzuweichen.
 */
export const DEVELOPER_IDENTITY_TRIGGER_PATTERN =
  '(?:dein\\w* (?:entwickler|programmierer)|(?:wer hat|von wem)\\b.*(?:dich|du|v[-_ ]?bot).*(?:entwick|programm|bau|erstell|erschaff|mach|cod)|(?:entwickler|hinter).*v[-_ ]?bot|who (?:.*ed|built) you)';

/**
 * Ausfuehrlicher Matcher fuer direkte Identitaetsfragen, z.B. /ai ask.
 * Dieser Pattern ist nicht nutzerdefiniert und wird nicht ueber safeRegexTest
 * ausgewertet; dadurch koennen hier alle relevanten Formulierungen praezise
 * abgedeckt werden.
 */
const DEVELOPER_IDENTITY_MATCH_PATTERN = [
  `\\bwer\\s+ist\\s+dein(?:e|er)?\\s+${DEVELOPER_TERMS}\\b`,
  `\\bwer\\s+ist\\s+(?:der|die)\\s+${DEVELOPER_TERMS}\\s+(?:von|hinter)\\s+${VBOT}\\b`,
  `\\b${DEVELOPER_TERMS}\\s+(?:von|hinter)\\s+${VBOT}\\b`,
  `\\bwer\\s+hat\\s+(?:dich|${VBOT})\\s+${CREATION_VERBS}\\b`,
  `\\bvon\\s+wem\\s+(?:wurdest\\s+du|wurde\\s+${VBOT})\\s+${CREATION_VERBS}\\b`,
  `\\bwer\\s+steckt\\s+hinter\\s+(?:dir|${VBOT})\\b`,
  `\\b(?:ist|war)\\s+.+?\\s+dein(?:e|er)?\\s+${DEVELOPER_TERMS}\\b`,
  `^\\s*dein(?:e|er)?\\s+${DEVELOPER_TERMS}\\s*[?!.]*\\s*$`,
  '\\bwho\\s+(?:is\\s+your\\s+(?:developer|creator|programmer)|(?:developed|created|programmed|built)\\s+you)\\b',
].join('|');

const developerIdentityRegex = new RegExp(DEVELOPER_IDENTITY_MATCH_PATTERN, 'i');

export function isDeveloperIdentityQuestion(text: string): boolean {
  if (!text) return false;
  return developerIdentityRegex.test(text.trim());
}

export function getDeveloperIdentityAnswer(): string {
  return `Mein Entwickler ist **${BOT_DEVELOPER}**.`;
}
