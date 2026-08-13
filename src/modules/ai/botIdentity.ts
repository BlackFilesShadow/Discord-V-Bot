export const BOT_DEVELOPER = 'Void_Architect' as const;

const DEV = '(?:entwickler(?:in)?|developer|programmierer(?:in)?|ersteller(?:in)?|erschaffer(?:in)?|creator)';
const VERB = '(?:gebaut|erschaffen|erstellt|programmiert|gemacht|entwickelt|gecodet|created|developed|programmed|built)';
const VBOT = 'v[-_ ]?bot(?:\\s+prime)?';

/**
 * Nur explizite Entwicklerfragen duerfen den globalen Trigger ausloesen.
 * "System/Provider hinter V-Bot" ist bewusst kein Identitaets-Trigger.
 * Muss wegen safeRegexTest unter 200 Zeichen bleiben.
 */
export const DEVELOPER_IDENTITY_TRIGGER_PATTERN =
  '(?:wer ist dein\\w* (?:entwickler|programmierer)|wer steckt hinter v[-_ ]?bot|wer hat v[-_ ]?bot (?:entwickelt|programmiert|gebaut|erstellt)|entwickler von v[-_ ]?bot\\s*\\??$)';

const DIRECT = new RegExp([
  `\\bwer\\s+ist\\s+dein(?:e|er)?\\s+${DEV}\\b`,
  `\\bwer\\s+ist\\s+(?:der|die)\\s+${DEV}\\s+(?:von|hinter)\\s+${VBOT}\\b`,
  `\\b${DEV}\\s+(?:von|hinter)\\s+${VBOT}\\b`,
  `\\bwer\\s+hat\\s+(?:dich|${VBOT})\\s+${VERB}\\b`,
  `\\bvon\\s+wem\\s+(?:wurdest\\s+du|wurde\\s+${VBOT})\\s+${VERB}\\b`,
  `\\bwer\\s+steckt\\s+hinter\\s+(?:dir|${VBOT})\\b`,
  `\\b(?:ist|war)\\s+.+?\\s+dein(?:e|er)?\\s+${DEV}\\b`,
  `^\\s*dein(?:e|er)?\\s+${DEV}\\s*[?!.]*\\s*$`,
  '\\bwho\\s+(?:is\\s+your\\s+(?:developer|creator|programmer)|(?:developed|created|programmed|built)\\s+you)\\b',
].join('|'), 'i');

export function isDeveloperIdentityQuestion(text: string): boolean {
  return Boolean(text) && DIRECT.test(text.trim());
}

export function getDeveloperIdentityAnswer(): string {
  return `Mein Entwickler ist **${BOT_DEVELOPER}**.`;
}
