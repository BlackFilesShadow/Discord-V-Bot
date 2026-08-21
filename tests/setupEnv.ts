/**
 * Local CI-parity env placeholders for Jest.
 * Values are non-secret test fixtures only — never production credentials.
 */
function ensure(name: string, value: string): void {
  if (!process.env[name] || String(process.env[name]).trim() === '') {
    process.env[name] = value;
  }
}

// Secrets: ENCRYPTION_KEY must be 64 hex chars (32 bytes AES). Others are opaque strings.
const TEST_ENCRYPTION_KEY_HEX = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const TEST_SESSION_SECRET = 'test-session-secret-not-real-0123456789abcdef';
const TEST_STEP_UP_SECRET = 'test-ai-tool-step-up-secret-0123456789abcdef';

ensure('NODE_ENV', 'test');
// Always provide a URL so config/prisma modules load. Real DB integration suites
// gate on RUN_DB_TESTS / CI (see tests/helpers/dbIntegration.ts).
ensure(
  'DATABASE_URL',
  process.env.DATABASE_URL
    || 'postgresql://discordbot:testpass_ci_only@127.0.0.1:5433/discord_v_bot_test?schema=public',
);
ensure('DISCORD_TOKEN', 'test-discord-token-not-real');
ensure('DISCORD_CLIENT_ID', '123456789012345678');
ensure('DISCORD_CLIENT_SECRET', 'test-discord-client-secret-not-real');
ensure('BOT_OWNER_ID', '123456789012345678');
ensure('DISCORD_OWNER_ID', process.env.BOT_OWNER_ID || '123456789012345678');
// Force a valid AES-256 hex key for tests when missing/invalid (do not weaken prod).
if (!/^[0-9a-fA-F]{64}$/.test(String(process.env.ENCRYPTION_KEY || ''))) {
  process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY_HEX;
}
ensure('SESSION_SECRET', TEST_SESSION_SECRET);
ensure('DASHBOARD_URL', 'http://127.0.0.1:3000');
ensure('AI_TOOL_STEP_UP_SECRET', TEST_STEP_UP_SECRET);
