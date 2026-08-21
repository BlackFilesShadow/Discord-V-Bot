/**
 * Gate for PostgreSQL integration suites.
 *
 * - CI / GITHUB_ACTIONS: run when DATABASE_URL is set (real service).
 * - Local default: skip unless RUN_DB_TESTS=1 (avoids false fails without Docker).
 * - FORCE_DB_INTEGRATION=1 always runs; SKIP_DB_INTEGRATION=1 always skips.
 */
export function dbIntegrationEnabled(): boolean {
  if (process.env.SKIP_DB_INTEGRATION === '1') return false;
  if (process.env.FORCE_DB_INTEGRATION === '1') return true;
  if (process.env.RUN_DB_TESTS === '1') return Boolean(process.env.DATABASE_URL);
  if (process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true') {
    return Boolean(process.env.DATABASE_URL);
  }
  return false;
}

export const describeDb = dbIntegrationEnabled() ? describe : describe.skip;
