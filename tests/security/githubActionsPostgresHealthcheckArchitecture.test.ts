import fs from 'node:fs';
import path from 'node:path';

import { normalizeSourceNewlines } from '../helpers/sourceText';

const read = (relative: string) =>
  normalizeSourceNewlines(fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8'));

const count = (source: string, needle: string) => source.split(needle).length - 1;

const POSTGRES_USER = 'POSTGRES_USER: test';
const POSTGRES_DB = 'POSTGRES_DB: discord_v_bot_test';
const QUALIFIED_HEALTHCHECK = '--health-cmd "pg_isready -U test -d discord_v_bot_test"';
const BARE_HEALTHCHECK = '--health-cmd pg_isready';

const ACTIVE_POSTGRES_WORKFLOWS = {
  '.github/workflows/ci.yml': 1,
  '.github/workflows/verification2.yml': 2,
  '.github/workflows/e2e.yml': 1,
  '.github/workflows/stage51-soak.yml': 1,
  '.github/workflows/stage59-chaos.yml': 2,
} as const;

describe('GitHub Actions PostgreSQL healthchecks', () => {
  it('targets the configured test role and database in every active PostgreSQL service', () => {
    for (const [workflow, expectedServiceCount] of Object.entries(ACTIVE_POSTGRES_WORKFLOWS)) {
      const source = read(workflow);

      expect(count(source, POSTGRES_USER)).toBe(expectedServiceCount);
      expect(count(source, POSTGRES_DB)).toBe(expectedServiceCount);
      expect(count(source, QUALIFIED_HEALTHCHECK)).toBe(expectedServiceCount);
      expect(source).not.toContain(BARE_HEALTHCHECK);
    }
  });

  it('does not weaken itself with skipped or focused tests', () => {
    const self = read('tests/security/githubActionsPostgresHealthcheckArchitecture.test.ts');
    expect(self).not.toMatch(/test\.(only|skip)|describe\.(only|skip)/);
  });
});
