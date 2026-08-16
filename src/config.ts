import dotenv from 'dotenv';
import path from 'path';
import { resolveBotOwnerId } from './security/privilegedIdentity';
import { parseAiProvider, resolveAiModel } from './modules/ai/modelRegistry';

dotenv.config();

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Fehlende Umgebungsvariable: ${key}`);
  }
  return value;
}

function optionalEnv(key: string, defaultValue: string = ''): string {
  return process.env[key] || defaultValue;
}

const metricsToken = optionalEnv('METRICS_TOKEN', '').trim();
const metricsRequested = optionalEnv('METRICS_ENABLED', 'false') === 'true';

export const config = {
  // Discord Bot
  discord: {
    token: requireEnv('DISCORD_TOKEN'),
    clientId: requireEnv('DISCORD_CLIENT_ID'),
    clientSecret: requireEnv('DISCORD_CLIENT_SECRET'),
    guildId: optionalEnv('DISCORD_GUILD_ID'),
    // BOT_OWNER_ID ist kanonisch. DISCORD_OWNER_ID bleibt nur als kontrollierter
    // Migrationsalias fuer bestehende Deployments erhalten. Konflikte oder
    // ungueltige Snowflakes stoppen den Start statt eine Identitaet zu erraten.
    ownerId: resolveBotOwnerId(),
  },

  // Datenbank
  database: {
    url: requireEnv('DATABASE_URL'),
  },

  // Web-Dashboard
  dashboard: {
    port: parseInt(optionalEnv('DASHBOARD_PORT', '3000'), 10),
    url: optionalEnv('DASHBOARD_URL', 'http://localhost:3000'),
    sessionSecret: requireEnv('SESSION_SECRET'),
    oauth2RedirectUri: optionalEnv('OAUTH2_REDIRECT_URI', 'http://localhost:3000/auth/callback'),
    trustProxy: optionalEnv('TRUST_PROXY', '1'),
  },

  // Sicherheit
  security: {
    encryptionKey: requireEnv('ENCRYPTION_KEY'),
    twoFactorIssuer: optionalEnv('TWO_FACTOR_ISSUER', 'Discord-V-Bot'),
    otpExpiryMinutes: 30,
    sessionTimeoutMinutes: 60,
    maxLoginAttempts: 5,
    lockoutDurationMinutes: 15,
  },

  // Upload-System
  upload: {
    dir: path.resolve(optionalEnv('UPLOAD_DIR', './uploads')),
    factionsDir: path.resolve(optionalEnv('UPLOAD_DIR', './uploads'), 'factions'),
    privateDir: path.resolve(optionalEnv('PRIVATE_UPLOAD_DIR', './private')),
    devUploadDir: path.resolve(optionalEnv('DEV_UPLOAD_DIR', './private/dev-logs')),
    exportDir: path.resolve(optionalEnv('EXPORT_DIR', './private/exports')),
    maxFileSizeBytes: parseInt(optionalEnv('MAX_FILE_SIZE_BYTES', '26214400'), 10),
    allowedExtensions: optionalEnv('ALLOWED_EXTENSIONS', '.xml,.json').split(','),
    chunkSize: 10 * 1024 * 1024,
  },

  // AI (Multi-Provider Fallback: Groq → Cerebras → OpenRouter → Gemini → OpenAI)
  // Providernamen und Modell-Defaults werden zentral validiert/migriert, damit
  // abgeschaltete Provider-Modelle nicht ueber alte .env-Werte wiederkehren.
  ai: {
    provider: parseAiProvider(optionalEnv('AI_PROVIDER', 'groq')),
    groqApiKey: optionalEnv('GROQ_API_KEY'),
    groqModel: resolveAiModel('groq', optionalEnv('GROQ_MODEL')),
    cerebrasApiKey: optionalEnv('CEREBRAS_API_KEY'),
    cerebrasModel: resolveAiModel('cerebras', optionalEnv('CEREBRAS_MODEL')),
    openrouterApiKey: optionalEnv('OPENROUTER_API_KEY'),
    openrouterModel: resolveAiModel('openrouter', optionalEnv('OPENROUTER_MODEL')),
    geminiApiKey: optionalEnv('GEMINI_API_KEY'),
    geminiModel: resolveAiModel('gemini', optionalEnv('GEMINI_MODEL')),
    openaiApiKey: optionalEnv('OPENAI_API_KEY'),
    openaiModel: resolveAiModel('openai', optionalEnv('OPENAI_MODEL')),
  },

  // Externe APIs
  external: {
    twitchClientId: optionalEnv('TWITCH_CLIENT_ID'),
    twitchClientSecret: optionalEnv('TWITCH_CLIENT_SECRET'),
    twitterBearerToken: optionalEnv('TWITTER_BEARER_TOKEN'),
    steamApiKey: optionalEnv('STEAM_API_KEY'),
    youtubeApiKey: optionalEnv('YOUTUBE_API_KEY'),
  },

  // Developer: Passwort ist ausschliesslich Step-up und erzeugt niemals
  // Developer-Identitaet oder -Rechte.
  developer: {
    password: optionalEnv('DEV_PASSWORD', ''),
  },

  logging: {
    level: optionalEnv('LOG_LEVEL', 'info'),
    dir: path.resolve(optionalEnv('LOG_DIR', './logs')),
  },

  rateLimit: {
    windowMs: parseInt(optionalEnv('RATE_LIMIT_WINDOW_MS', '60000'), 10),
    maxRequests: parseInt(optionalEnv('RATE_LIMIT_MAX_REQUESTS', '30'), 10),
  },

  monitoring: {
    // /metrics ist nur dann aktiv, wenn die Funktion explizit angefordert UND
    // ein ausreichend langes Bearer-Secret vorhanden ist. Ein altes
    // METRICS_ENABLED=true ohne Token wird sicher als deaktiviert behandelt und
    // erzeugt keinen widerspruechlichen Runtime-Warnzustand mehr.
    metricsRequested,
    metricsEnabled: metricsRequested && metricsToken.length >= 32,
    metricsToken,
    errorWebhookUrl: optionalEnv('ERROR_WEBHOOK_URL', ''),
  },

  features: {
    feedbackChannelId: optionalEnv('FEEDBACK_CHANNEL_ID', ''),
  },

  nitrado: {
    writeProtection: optionalEnv('NITRADO_WRITE_PROTECTION', 'true') !== 'false',
    // Kompatibilitaets-/Statuswert: Die Gameplay-Feed-Runtime ist produktiv
    // immer aktiv. Ob Discord-Nachrichten entstehen, steuern nur explizite
    // GameplayFeedConfig-Eintraege pro Guild + Gameserver + Channel.
    admEventPipelineV2: true,
  },

  member: {
    syncEnabled: optionalEnv('MEMBER_SYNC_ENABLED', 'false') === 'true',
    syncIntervalHours: Math.min(Math.max(parseInt(optionalEnv('MEMBER_SYNC_INTERVAL_HOURS', '12'), 10) || 12, 1), 24),
  },
} as const;
