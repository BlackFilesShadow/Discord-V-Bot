/**
 * Production-Startup-Guards (P0/P1-Haertung).
 *
 * Schutzschicht, die NUR in Production (`NODE_ENV=production`) greift:
 *
 *   Default-/Platzhalter-Secrets verhindern.
 *   Kanonische Developer-Identitaet (`BOT_OWNER_ID`) erzwingen.
 *
 * Die Funktion `collectProductionEnvErrors()` ist seiteneffektfrei und
 * vollstaendig testbar; `assertProductionEnv()` ruft sie auf und beendet
 * den Prozess mit klarer Meldung, falls Fehler vorliegen.
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

const DISCORD_SNOWFLAKE_RE = /^\d{17,20}$/;

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
        `${key} traegt noch den Platzhalterwert "${placeholder}". In Production einen echten Wert setzen.`,
      );
    }
  }

  const dbUrl = env.DATABASE_URL ?? '';
  if (dbUrl.includes('changeme')) {
    errors.push('DATABASE_URL enthaelt "changeme" — Default-Passwort in Production nicht erlaubt.');
  }

  // Revision VI: Eine privilegierte Developer-Identitaet darf in Production
  // niemals implizit aus Namen, Rollen oder einem Shared Password entstehen.
  // BOT_OWNER_ID ist die kanonische Identitaet und muss ein Discord-Snowflake sein.
  const ownerId = (env.BOT_OWNER_ID ?? '').trim();
  if (!ownerId) {
    errors.push('BOT_OWNER_ID fehlt — kanonische Developer-Identitaet ist in Production Pflicht.');
  } else if (!DISCORD_SNOWFLAKE_RE.test(ownerId)) {
    errors.push('BOT_OWNER_ID ist kein gueltiges Discord-Snowflake (17-20 Ziffern).');
  }

  return errors;
}

/**
 * Prueft die Production-Konfiguration und beendet den Prozess mit klarer
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
