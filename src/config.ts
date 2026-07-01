import dotenv from 'dotenv';
import path from 'path';

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

export const config = {
  // Discord Bot
  discord: {
    token: requireEnv('DISCORD_TOKEN'),
    clientId: requireEnv('DISCORD_CLIENT_ID'),
    clientSecret: requireEnv('DISCORD_CLIENT_SECRET'),
    guildId: optionalEnv('DISCORD_GUILD_ID'),
    ownerId: optionalEnv('BOT_OWNER_ID'),
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
    // Express `trust proxy`-Wert. Standard `1` (genau ein Reverse-Proxy, z.B.
    // Nginx/Traefik vor dem Container). Per TRUST_PROXY ueberschreibbar:
    // Zahl (Hop-Anzahl), `true`/`false`, oder CIDR/IP-Liste. Siehe README.
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
    // Nur dieser Unterpfad von `dir` wird oeffentlich unter /uploads/factions
    // per express.static ausgeliefert (siehe server.ts). Alles andere bleibt privat.
    factionsDir: path.resolve(optionalEnv('UPLOAD_DIR', './uploads'), 'factions'),
    // Private Ablage ausserhalb des oeffentlichen uploads-Verzeichnisses.
    privateDir: path.resolve(optionalEnv('PRIVATE_UPLOAD_DIR', './private')),
    // DEV-Log-Uploads. MUSS privat sein (nur ueber authentifizierten DEV-Endpoint
    // lesbar) — daher unter ./private/dev-logs, NICHT unter ./uploads.
    devUploadDir: path.resolve(optionalEnv('DEV_UPLOAD_DIR', './private/dev-logs')),
    // Private Export-Ablage. MUSS ausserhalb von `dir` liegen, da `dir`
    // (uploads) per express.static oeffentlich unter /uploads ausgeliefert wird.
    // Audit-/GDPR-Exporte duerfen niemals oeffentlich abrufbar sein.
    exportDir: path.resolve(optionalEnv('EXPORT_DIR', './private/exports')),
    // Sicherheits-Default 25 MB: Uploads werden zur Validierung vollstaendig in
    // den Speicher geladen (Buffer). Ein zu hoher Default (frueher 2 GB) erlaubt
    // Memory-DoS. Erlaubt sind ohnehin nur .xml/.json — 25 MB ist dafuer
    // grosszuegig. Bei Bedarf per MAX_FILE_SIZE_BYTES anheben.
    maxFileSizeBytes: parseInt(optionalEnv('MAX_FILE_SIZE_BYTES', '26214400'), 10), // 25 MB
    allowedExtensions: optionalEnv('ALLOWED_EXTENSIONS', '.xml,.json').split(','),
    chunkSize: 10 * 1024 * 1024, // 10 MB chunks
  },

  // AI (Multi-Provider Fallback: Groq → Cerebras → OpenRouter → Gemini → OpenAI)
  ai: {
    provider: optionalEnv('AI_PROVIDER', 'groq') as
      | 'groq'
      | 'cerebras'
      | 'openrouter'
      | 'gemini'
      | 'openai',
    groqApiKey: optionalEnv('GROQ_API_KEY'),
    groqModel: optionalEnv('GROQ_MODEL', 'llama-3.3-70b-versatile'),
    cerebrasApiKey: optionalEnv('CEREBRAS_API_KEY'),
    cerebrasModel: optionalEnv('CEREBRAS_MODEL', 'llama-3.3-70b'),
    openrouterApiKey: optionalEnv('OPENROUTER_API_KEY'),
    openrouterModel: optionalEnv('OPENROUTER_MODEL', 'meta-llama/llama-3.3-70b-instruct:free'),
    geminiApiKey: optionalEnv('GEMINI_API_KEY'),
    geminiModel: optionalEnv('GEMINI_MODEL', 'gemini-2.0-flash'),
    openaiApiKey: optionalEnv('OPENAI_API_KEY'),
    openaiModel: optionalEnv('OPENAI_MODEL', 'gpt-4'),
  },

  // Externe APIs
  external: {
    twitchClientId: optionalEnv('TWITCH_CLIENT_ID'),
    twitchClientSecret: optionalEnv('TWITCH_CLIENT_SECRET'),
    twitterBearerToken: optionalEnv('TWITTER_BEARER_TOKEN'),
    steamApiKey: optionalEnv('STEAM_API_KEY'),
    youtubeApiKey: optionalEnv('YOUTUBE_API_KEY'),
  },

  // Developer
  developer: {
    password: optionalEnv('DEV_PASSWORD', ''),
  },

  // Logging
  logging: {
    level: optionalEnv('LOG_LEVEL', 'info'),
    dir: path.resolve(optionalEnv('LOG_DIR', './logs')),
  },

  // Rate Limiting
  rateLimit: {
    windowMs: parseInt(optionalEnv('RATE_LIMIT_WINDOW_MS', '60000'), 10),
    maxRequests: parseInt(optionalEnv('RATE_LIMIT_MAX_REQUESTS', '30'), 10),
  },

  // Monitoring / Telemetrie
  monitoring: {
    metricsEnabled: optionalEnv('METRICS_ENABLED', 'true') !== 'false',
    metricsToken: optionalEnv('METRICS_TOKEN', ''), // Optional: Bearer-Token-Schutz fuer /metrics
    errorWebhookUrl: optionalEnv('ERROR_WEBHOOK_URL', ''), // Discord-Webhook fuer Error-Push
  },

  // Phase B: Quick-Wins
  features: {
    feedbackChannelId: optionalEnv('FEEDBACK_CHANNEL_ID', ''), // Optional: alle /feedback gehen zusaetzlich hierher
  },

  // Nitrado (Spec §12): Read-Only-Datenerfassung maximieren, Schreibaktionen extra schuetzen.
  nitrado: {
    // Standard: AN. Schreibende Nitrado-Aktionen brauchen dann Permission + Confirm + Reason + Audit.
    // Nur via NITRADO_WRITE_PROTECTION=false explizit deaktivierbar.
    writeProtection: optionalEnv('NITRADO_WRITE_PROTECTION', 'true') !== 'false',
  },

  // Member-Erfassung (Spec §11): optionaler Hintergrund-Sync.
  member: {
    // Standard: AUS. Wenn AN, laeuft ein rate-limit-freundlicher Member-Sync-Job.
    syncEnabled: optionalEnv('MEMBER_SYNC_ENABLED', 'false') === 'true',
    // Intervall in Stunden (default 12), nur relevant wenn syncEnabled.
    syncIntervalHours: Math.min(Math.max(parseInt(optionalEnv('MEMBER_SYNC_INTERVAL_HOURS', '12'), 10) || 12, 1), 24),
  },
} as const;
