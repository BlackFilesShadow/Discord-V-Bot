/**
 * Production-Startup-Guards (P0/P1-Härtung).
 *
 * Schutzschicht, die NUR in Production (`NODE_ENV=production`) greift:
 * - Default-/Platzhalter-Secrets verhindern.
 * - Kanonische globale Developer-Identitaet erzwingen:
 *   BOT_OWNER_ID ist primaer; DISCORD_OWNER_ID ist nur Legacy-Alias.
 *   Die effektive Owner-ID muss eine Discord-Snowflake sein.
 *   Wenn beide Variablen gesetzt sind, muessen sie identisch sein.
 *
 * `collectProductionEnvErrors()` ist seiteneffektfrei und testbar;
 * `assertProductionEnv()` bricht den Production-Start fail-closed ab.
 */

export interface EnvLike {
  [key: string]: string | undefined;
}

const PLACEHOLDER_SECRETS: ReadonlyArray<{ key: string; placeholder: string }> = [
  { key: 'DISCORD_TOKEN', placeholder: 'your_discord_bot_token_here' },
  { key: 'DISCORD_CLIENT_ID', placeholder: 'your_client_id_here' },
  { key: 'DISCORD_CLIENT_SECRET', placeholder: 'your_client_secret_here' },
  { key: 'POSTGRES_PASSWORD', placeholder: 'changeme' },
  { key: 'SESSION_SECRET', placeholder: 'your_session_secret_here_min_64_chars' },
  { key: 'ENCRYPTION_KEY', placeholder: 'your_32_byte_encryption_key_hex' },
  { key: 'DEV_PASSWORD', placeholder: 'change_me_to_a_long_random_secret' },
  { key: 'GROQ_API_KEY', placeholder: 'your_groq_api_key_here' },
  { key: 'GEMINI_API_KEY', placeholder: 'your_gemini_api_key_here' },
  { key: 'OPENAI_API_KEY', placeholder: 'your_openai_api_key_here' },
];

/** Discord-Snowflakes sind dezimale 64-bit IDs; 17..20 Ziffern decken Legacy + aktuelle IDs ab. */
export function isDiscordSnowflake(value: string | undefined): boolean {
  return typeof value === 'string' && /^\d{17,20}$/.test(value.trim());
}

/**
 * Sammelt alle Production-Startfehler. Leeres Array => Konfiguration ok.
 * `env` ist injizierbar, damit die Logik ohne globalen Zustand testbar ist.
 */
export function collectProductionEnvErrors(env: EnvLike = process.env): string[] {
  const errors: string[] = [];

  for (const { key, placeholder } of PLACEHOLDER_SECRETS) {
    const value = env[key];
    if (value !== undefined && value.trim() === placeholder) {
      errors.push(
        `${key} trägt noch den Platzhalterwert "${placeholder}". In Production einen echten Wert setzen.`,
      );
    }
  }

  const dbUrl = env.DATABASE_URL ?? '';
  if (dbUrl.includes('changeme')) {
    errors.push('DATABASE_URL enthält "changeme" — Default-Passwort in Production nicht erlaubt.');
  }

  // Revision VI / DEV-ID-001:
  // BOT_OWNER_ID ist kanonisch; DISCORD_OWNER_ID darf nur als Migrationsalias
  // dienen. Rechte duerfen niemals aus einem Shared-Password entstehen.
  const canonicalOwner = env.BOT_OWNER_ID?.trim() ?? '';
  const legacyOwner = env.DISCORD_OWNER_ID?.trim() ?? '';
  const effectiveOwner = canonicalOwner || legacyOwner;

  if (!effectiveOwner) {
    errors.push('BOT_OWNER_ID fehlt. In Production ist eine globale Developer-Owner-ID zwingend erforderlich.');
  } else if (!isDiscordSnowflake(effectiveOwner)) {
    errors.push('BOT_OWNER_ID/DISCORD_OWNER_ID ist keine gueltige Discord-Snowflake (17..20 Ziffern).');
  }

  if (canonicalOwner && legacyOwner && canonicalOwner !== legacyOwner) {
    errors.push('BOT_OWNER_ID und DISCORD_OWNER_ID widersprechen sich. Legacy-Alias entfernen oder identisch setzen.');
  }

  return errors;
}

/**
 * Prüft die Production-Konfiguration und beendet den Prozess mit klarer
 * Fehlerliste, falls Pflichtwerte fehlen. In Nicht-Production passiert nichts.
 */
export function assertProductionEnv(
  env: EnvLike = process.env,
  log: (msg: string) => void = (m) => console.error(m),
): void {
  if (env.NODE_ENV !== 'production') return;

  const errors = collectProductionEnvErrors(env);
  if (errors.length === 0) return;

  log('==================================================================');
  log(' START ABGEBROCHEN — unsichere Production-Konfiguration erkannt:');
  log('==================================================================');
  for (const e of errors) log(`  ✖ ${e}`);
  log('------------------------------------------------------------------');
  log(' Bitte .env korrigieren und den Bot erneut starten.');
  log('==================================================================');
  process.exit(1);
}
