import { createHmac } from 'node:crypto';

const SUBJECT_PREFIX = 'es1_';

function cleanSubjectPart(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 128 || /[\r\n\t]/.test(trimmed)) {
    throw new Error(`${label} muss ein nicht-leerer Scope-Identifier mit max. 128 Zeichen sein.`);
  }
  return trimmed;
}

/**
 * Stabiler, guild-gescoppter Pseudonym-Schluessel fuer unveraenderliche
 * Economy-/Reward-Historie. 128 Bit HMAC-Ausgabe reichen fuer den lokalen
 * Subject-Namespace; der geheime Schluessel bleibt serverseitig.
 *
 * Snowflake-Validierung gehoert an die externe Leave-Request-Grenze. Dieser
 * interne Primitive akzeptiert absichtlich auch streng typisierte Legacy-/Test-
 * Scope-Identifier, ohne die kryptografische Guild-Trennung aufzuweichen.
 */
export function economySubjectKey(guildId: string, userDiscordId: string, secret: string): string {
  const guild = cleanSubjectPart(guildId, 'guildId');
  const user = cleanSubjectPart(userDiscordId, 'userDiscordId');
  if (secret.length < 32) throw new Error('Economy-Subject-HMAC-Secret ist zu kurz.');
  const digest = createHmac('sha256', secret)
    .update(`economy-subject:v1:${guild}:${user}`)
    .digest('hex')
    .slice(0, 32);
  return `${SUBJECT_PREFIX}${digest}`;
}

export function replaceEconomySubject(value: string | null, rawUserId: string, subjectKey: string): string | null {
  if (value === null) return null;
  return value.split(rawUserId).join(subjectKey);
}
