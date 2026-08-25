const SNOWFLAKE = /^\d{17,20}$/;

export type PrivilegedRole = 'USER' | 'ADMIN' | 'SUPER_ADMIN' | 'DEVELOPER' | string;

/**
 * Resolves the canonical bot-owner identity.
 * BOT_OWNER_ID is canonical; DISCORD_OWNER_ID is a temporary migration alias.
 * Conflicting or malformed values fail closed at startup instead of silently
 * selecting one identity.
 */
export function resolveBotOwnerId(env: NodeJS.ProcessEnv = process.env): string {
  const canonical = (env.BOT_OWNER_ID ?? '').trim();
  const legacy = (env.DISCORD_OWNER_ID ?? '').trim();

  if (canonical && legacy && canonical !== legacy) {
    throw new Error('BOT_OWNER_ID und DISCORD_OWNER_ID widersprechen sich.');
  }
  const selected = canonical || legacy;
  if (selected && !SNOWFLAKE.test(selected)) {
    throw new Error('BOT_OWNER_ID/DISCORD_OWNER_ID muss eine gueltige Discord-Snowflake sein.');
  }
  return selected;
}

/**
 * GlobalDeveloperIdentity: Die kanonische BOT_OWNER_ID ist die unverlierbare
 * globale Developer-Identitaet. DB-Rollen bleiben fuer weitere Developer-
 * Konten relevant, duerfen dem kanonischen Owner aber niemals durch Rollen-
 * Drift, Recovery oder einen fehlerhaften Rollen-Write den DEV-Zugriff nehmen.
 * Passwort/DEV-Session bleiben davon getrennte Step-up-Faktoren.
 */
export function isGlobalDeveloperIdentity(
  discordId: string,
  role: PrivilegedRole,
  ownerId: string,
): boolean {
  if (!ownerId || discordId !== ownerId) return false;
  return true;
}

/**
 * Global Bot-Admin identity. The shared BOT_ADMIN_PASSWORD is only a step-up
 * factor; eligibility comes from the authenticated Discord identity + DB role.
 * The canonical bot owner remains eligible for recovery/bootstrap.
 */
export function isGlobalBotAdminIdentity(
  discordId: string,
  role: PrivilegedRole,
  ownerId: string,
): boolean {
  if (ownerId && discordId === ownerId) return true;
  return role === 'ADMIN' || role === 'SUPER_ADMIN' || role === 'DEVELOPER';
}
