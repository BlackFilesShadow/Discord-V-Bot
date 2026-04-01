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
    maxFileSizeBytes: parseInt(optionalEnv('MAX_FILE_SIZE_BYTES', '2147483648'), 10), // 2 GB
    allowedExtensions: optionalEnv('ALLOWED_EXTENSIONS', '.xml,.json').split(','),
    chunkSize: 10 * 1024 * 1024, // 10 MB chunks
  },

  // AI (Multi-Provider: Groq → Gemini → OpenAI Fallback)
  ai: {
    provider: optionalEnv('AI_PROVIDER', 'groq') as 'groq' | 'gemini' | 'openai',
    groqApiKey: optionalEnv('GROQ_API_KEY'),
    groqModel: optionalEnv('GROQ_MODEL', 'llama-3.3-70b-versatile'),
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
} as const;
