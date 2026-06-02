/**
 * Production-Startup-Guards (P0/P1-Härtung).
 *
 * Schutzschicht, die NUR in Production (`NODE_ENV=production`) greift:
 *
 *   Default-/Platzhalter-Secrets verhindern (Task 2):
 *      Wenn ein Pflicht-Secret noch den .env.example-Platzhalter trägt
 *      (z.B. `your_discord_bot_token_here` oder `changeme`), bricht der
 *      Start ab. Leere OPTIONALE API-Keys bleiben erlaubt.
 *
 * Hinweis: Der DEV-Bereich ist bewusst NUR passwortgeschützt
 * (`DEV_PASSWORD`). Es gibt KEINEN Startzwang für 2FA oder IP-Allowlist.
 *
 * Die Funktion `collectProductionEnvErrors()` ist seiteneffektfrei und
 * vollständig testbar; `assertProductionEnv()` ruft sie auf und beendet
 * den Prozess mit klarer Meldung, falls Fehler vorliegen.
 */

export interface EnvLike {
  [key: string]: string | undefined;
}

/**
 * Platzhalterwerte aus `.env.example`, die in Production niemals echte
 * Secrets sein dürfen. Key -> exakter verbotener Platzhalterwert.
 */
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

/**
 * Sammelt alle Production-Startfehler. Leeres Array => Konfiguration ok.
 * `env` ist injizierbar, damit die Logik ohne globalen Zustand testbar ist.
 */
export function collectProductionEnvErrors(env: EnvLike = process.env): string[] {
  const errors: string[] = [];

  // --- Task 2: Default-/Platzhalter-Secrets ---
  for (const { key, placeholder } of PLACEHOLDER_SECRETS) {
    const value = env[key];
    // Leere optionale Werte sind erlaubt (z.B. ungenutzte API-Keys).
    if (value !== undefined && value.trim() === placeholder) {
      errors.push(
        `${key} trägt noch den Platzhalterwert "${placeholder}". In Production einen echten Wert setzen.`,
      );
    }
  }

  // DATABASE_URL enthält "changeme" -> Default-Passwort im Connection-String.
  const dbUrl = env.DATABASE_URL ?? '';
  if (dbUrl.includes('changeme')) {
    errors.push('DATABASE_URL enthält "changeme" — Default-Passwort in Production nicht erlaubt.');
  }

  // Hinweis: Der DEV-Bereich ist bewusst NUR passwortgeschützt. Es gibt
  // KEINEN Production-Startzwang für 2FA (DEV_REQUIRE_MFA) oder IP-Allowlist
  // (DEV_REQUIRE_IP_ALLOWLIST) — diese bleiben optionale Opt-in-Features.

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
