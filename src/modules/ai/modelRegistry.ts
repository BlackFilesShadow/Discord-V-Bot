export const AI_PROVIDER_NAMES = ['groq', 'cerebras', 'openrouter', 'gemini', 'openai'] as const;
export type AiProviderName = typeof AI_PROVIDER_NAMES[number];

/**
 * Kanonische Modell-Defaults fuer V-Bot.
 *
 * Diese Werte liegen absichtlich an EINER Stelle. Provider-Modelle werden
 * regelmaessig abgekuendigt; verstreute Defaults in Config/Setup/Tests haben in
 * der Vergangenheit dazu gefuehrt, dass neue Installationen mit bereits
 * abgeschalteten Modellen gestartet sind.
 *
 * WICHTIG:
 * - Explizit konfigurierte, unbekannte Modelle werden NICHT eigenmaechtig
 *   ersetzt. Nur unten dokumentierte Legacy-IDs werden kontrolliert migriert.
 * - Die Runtime-Fallback-Reihenfolge wird hier nicht festgelegt; sie bleibt im
 *   Provider-Router/ProviderStats-Modul.
 * - Aenderungen an Defaults muessen mit Provider-Dokumentation + Regressionstest
 *   erfolgen.
 */
export const AI_MODEL_DEFAULTS: Readonly<Record<AiProviderName, string>> = Object.freeze({
  // Groq: llama-3.3-70b-versatile wurde fuer Free/Developer am 16.08.2026
  // abgeschaltet. Offizieller empfohlener Ersatz: openai/gpt-oss-120b.
  groq: 'openai/gpt-oss-120b',

  // Cerebras: aktuelles oeffentliches Produktionsmodell.
  cerebras: 'gpt-oss-120b',

  // OpenRouter: bewusst ein konkretes kostenloses Modell statt Zufallsrouter,
  // damit Antwortverhalten reproduzierbarer bleibt. Provider-/Task-Routing wird
  // spaeter separat modernisiert.
  openrouter: 'meta-llama/llama-3.3-70b-instruct:free',

  // Google: aktuelle stabile GA-Flash-Variante (August 2026).
  gemini: 'gemini-3.7-flash',

  // OpenAI: aktuelle GPT-5.6-Familie. Luna ist der moderne, kostensensitive
  // High-Volume-Fallback; qualitaetsbasierte Terra/Sol-Auswahl folgt spaeter im
  // task-spezifischen Provider-Router statt hier blind teuer zu werden.
  openai: 'gpt-5.6-luna',
});

const LEGACY_MODEL_MIGRATIONS: Readonly<Record<AiProviderName, Readonly<Record<string, string>>>> = Object.freeze({
  groq: Object.freeze({
    'llama-3.3-70b-versatile': AI_MODEL_DEFAULTS.groq,
  }),
  cerebras: Object.freeze({
    'llama-3.3-70b': AI_MODEL_DEFAULTS.cerebras,
    'llama3.1-70b': AI_MODEL_DEFAULTS.cerebras,
  }),
  openrouter: Object.freeze({}),
  gemini: Object.freeze({
    'gemini-2.0-flash': AI_MODEL_DEFAULTS.gemini,
    'gemini-2.0-flash-001': AI_MODEL_DEFAULTS.gemini,
    'gemini-2.0-flash-lite': 'gemini-3.5-flash-lite',
    'gemini-2.0-flash-lite-001': 'gemini-3.5-flash-lite',
    // Alter interner Zwischen-Default aus frueheren V-Bot-Releases.
    'gemini-3.1-flash-lite': 'gemini-3.5-flash-lite',
  }),
  openai: Object.freeze({
    'gpt-4': AI_MODEL_DEFAULTS.openai,
    'gpt-5.4-mini': AI_MODEL_DEFAULTS.openai,
  }),
});

export function parseAiProvider(configured?: string | null): AiProviderName {
  const requested = (configured ?? '').trim().toLowerCase();
  if (!requested) return 'groq';
  if ((AI_PROVIDER_NAMES as readonly string[]).includes(requested)) {
    return requested as AiProviderName;
  }
  throw new Error(
    `Ungueltiger AI_PROVIDER "${configured}". Erlaubt: ${AI_PROVIDER_NAMES.join(', ')}`,
  );
}

/**
 * Liefert fuer einen Provider ein produktionsfaehiges Default-Modell und
 * migriert ausschliesslich bekannte Legacy-IDs. Eigene explizite Modellnamen
 * bleiben unangetastet, damit Dedicated-/Enterprise-Modelle nicht ueberschrieben
 * werden.
 */
export function resolveAiModel(provider: AiProviderName, configured?: string | null): string {
  const requested = (configured ?? '').trim();
  if (!requested) return AI_MODEL_DEFAULTS[provider];
  return LEGACY_MODEL_MIGRATIONS[provider][requested] ?? requested;
}

export function isKnownLegacyAiModel(provider: AiProviderName, model: string): boolean {
  return Object.prototype.hasOwnProperty.call(LEGACY_MODEL_MIGRATIONS[provider], model.trim());
}
