import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeSourceNewlines } from '../helpers/sourceText';

const root = process.cwd();
const read = (relative: string): string =>
  normalizeSourceNewlines(fs.readFileSync(path.join(root, relative), 'utf8'));

const expectedCollectAllSteps = [
  'root-npm-ci',
  'dashboard-npm-ci',
  'prisma-generate',
  'prisma-validate',
  'postgres-client',
  'redis-live',
  'lint-all',
  'build',
  'audit-artifacts',
  'radar-assets',
  'db-migrate-deploy',
  'db-migrate-status',
  'db-consistency',
  'db-lifecycle',
  'perf-baselines-46-48',
  'perf-series-46-49',
  'stage47-data-plane',
  'stage48-ai-nitrado',
  'stage50-full-stack-load',
  'synthetic-load',
  'jest-ci',
  'jest-open-handles',
  'playwright-browser',
  'playwright-real-db',
  'soak-smoke',
  'structural-chaos',
  'players-4000',
  'root-audit-critical',
  'root-audit-high',
  'root-audit-prod-high',
  'dashboard-audit-prod-high',
  'dashboard-audit-critical',
  'dashboard-audit-high',
] as const;

function runSummaryConverter(rows: string[], sha = '0123456789abcdef0123456789abcdef01234567') {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'vbot-audit-summary-'));
  const tsv = path.join(temp, 'summary.tsv');
  const json = path.join(temp, 'summary.json');
  fs.writeFileSync(
    tsv,
    [
      'step\tstatus\tclassification\texitCode\twarningLines\tdurationSec\tlog',
      ...rows,
      '',
    ].join('\n'),
    'utf8',
  );
  return { temp, tsv, json, sha };
}

describe('collect-all Linux audit safety', () => {
  const collectorPath = 'scripts/audit-collect-all.sh';
  const wrapperPath = 'scripts/audit-collect-all-docker.sh';
  const summaryPath = 'scripts/audit-summary-from-tsv.mjs';

  it('fails closed unless the data plane is the isolated audit network', () => {
    const collector = read(collectorPath);
    expect(collector).toContain('AUDIT_ISOLATED');
    expect(collector).toContain('NODE_ENV muss exakt test sein');
    expect(collector).toContain("db.hostname !== 'audit-postgres'");
    expect(collector).toContain("db.port !== '5432'");
    expect(collector).toContain("dbName !== 'discord_v_bot_audit'");
    expect(collector).toContain("redis.hostname !== 'audit-redis'");
    expect(collector).toContain('TEST-/UMGEBUNGSFEHLER');
  });

  it('collects independent failures instead of stopping after the first red block', () => {
    const collector = read(collectorPath);
    expect(collector).toContain('run_step()');
    expect(collector).toContain("SKIPPED\\tFOLGEFEHLER");
    expect(collector).not.toContain('set -euo pipefail');
  });

  it('captures Node warning class names such as MaxListenersExceededWarning', () => {
    const collector = read(collectorPath);
    expect(collector).toContain('WARNING_PATTERN=');
    expect(collector).toContain('[[:alnum:]_]+Warning');
    expect(collector).toContain('MaxListenersExceededWarning');
  });

  it('mirrors the canonical Jest leaked-worker/handle failure markers', () => {
    const collector = read(collectorPath);
    const ci = read('.github/workflows/ci.yml');
    const markers = [
      'A worker process has failed to exit gracefully',
      'Jest did not exit one second after the test run has completed',
    ];
    for (const marker of markers) {
      expect(ci).toContain(marker);
      expect(collector).toContain(marker);
    }
    expect(collector).toContain("if [[ \"$name\" == 'jest-ci' ]]");
    expect(collector).toContain('rc=98');
  });

  it('pins the complete 33-block collect-all inventory exactly once', () => {
    const collector = read(collectorPath);
    const actual = [...collector.matchAll(/^run_step '([^']+)'/gm)].map(match => match[1]);
    expect(actual).toEqual([...expectedCollectAllSteps]);
    expect(new Set(actual).size).toBe(expectedCollectAllSteps.length);
  });

  it('does not expose audit PostgreSQL/Redis or the Docker socket to the test runner', () => {
    const wrapper = read(wrapperPath);
    expect(wrapper).toContain('--network-alias audit-postgres');
    expect(wrapper).toContain('--network-alias audit-redis');
    expect(wrapper).toContain('docker port "$POSTGRES_CONTAINER"');
    expect(wrapper).toContain('docker port "$REDIS_CONTAINER"');
    expect(wrapper).not.toContain('5432:5432');
    expect(wrapper).not.toContain('6379:6379');
    expect(wrapper).not.toContain('--publish');
    expect(wrapper).not.toContain('/var/run/docker.sock');
  });

  it('keeps destructive real process-kill chaos outside the no-socket runner', () => {
    const collector = read(collectorPath);
    expect(collector).toContain('Real PostgreSQL/Redis process-kill chaos is');
    expect(collector).not.toContain('stage59-process-kill-chaos');
    expect(collector).not.toMatch(/\bdocker\s+(stop|start|restart|kill)\b/);
  });

  it('pins the formerly leaking dashboard origin during real-db Playwright', () => {
    const collector = read(collectorPath);
    expect(collector).toContain('E2E_PORT=4173');
    expect(collector).toContain('DASHBOARD_URL=http://localhost:3000');
    expect(collector).toContain('OAUTH2_REDIRECT_URI=http://localhost:3000/auth/callback');
    expect(collector).toContain('E2E_REAL_DB=1');
  });

  it('fails the overall audit on collector-internal or incomplete results', () => {
    const collector = read(collectorPath);
    expect(collector).toContain('collector_internal_failure=0');
    expect(collector).toContain('collector_internal_failure=1');
    expect(collector).toContain('INTERNAL_HARNESS_FAILURE=%s');
    expect(collector).toContain('"$failed" -gt 0 || "$skipped" -gt 0 || "$collector_internal_failure" -ne 0');
  });

  it('converts valid TSV block results into machine-readable JSON', () => {
    const fixture = runSummaryConverter([
      'lint-all\tPASS\tOK\t0\t2\t10\t/audit-output/logs/lint-all.log',
      'db-consistency\tFAIL\tECHTER FEHLER\t1\t0\t3\t/audit-output/logs/db-consistency.log',
      'players-4000\tSKIPPED\tFOLGEFEHLER\t-\t0\t0\t-',
    ]);

    try {
      execFileSync(process.execPath, [path.join(root, summaryPath), fixture.tsv, fixture.json, fixture.sha], {
        cwd: root,
        stdio: 'pipe',
      });
      const parsed = JSON.parse(fs.readFileSync(fixture.json, 'utf8')) as {
        sha: string;
        allGreen: boolean;
        totals: {
          steps: number;
          passed: number;
          failed: number;
          skippedFollowups: number;
          warningCandidates: number;
        };
      };
      expect(parsed.sha).toBe(fixture.sha);
      expect(parsed.allGreen).toBe(false);
      expect(parsed.totals).toEqual({
        steps: 3,
        passed: 1,
        failed: 1,
        skippedFollowups: 1,
        warningCandidates: 2,
      });
    } finally {
      fs.rmSync(fixture.temp, { recursive: true, force: true });
    }
  });

  it('never marks a skipped-only audit summary as green', () => {
    const fixture = runSummaryConverter([
      'lint-all\tPASS\tOK\t0\t0\t1\t/audit-output/logs/lint-all.log',
      'players-4000\tSKIPPED\tFOLGEFEHLER\t-\t0\t0\t-',
    ], 'fedcba9876543210fedcba9876543210fedcba98');

    try {
      execFileSync(process.execPath, [path.join(root, summaryPath), fixture.tsv, fixture.json, fixture.sha], {
        cwd: root,
        stdio: 'pipe',
      });
      const parsed = JSON.parse(fs.readFileSync(fixture.json, 'utf8')) as {
        allGreen: boolean;
        totals: { failed: number; skippedFollowups: number };
      };
      expect(parsed.totals.failed).toBe(0);
      expect(parsed.totals.skippedFollowups).toBe(1);
      expect(parsed.allGreen).toBe(false);
    } finally {
      fs.rmSync(fixture.temp, { recursive: true, force: true });
    }
  });

  it.each([
    ['no executed rows', []],
    ['duplicate step', [
      'lint-all\tPASS\tOK\t0\t0\t1\t/audit-output/logs/lint-all.log',
      'lint-all\tPASS\tOK\t0\t0\t1\t/audit-output/logs/lint-all.log',
    ]],
    ['PASS with non-zero exit', [
      'lint-all\tPASS\tOK\t1\t0\t1\t/audit-output/logs/lint-all.log',
    ]],
    ['FAIL with zero exit', [
      'lint-all\tFAIL\tECHTER FEHLER\t0\t0\t1\t/audit-output/logs/db-consistency.log',
    ]],
    ['SKIPPED with wrong classification', [
      'lint-all\tSKIPPED\tOK\t-\t0\t0\t-',
    ]],
  ])('rejects malformed summary integrity: %s', (_name, rows) => {
    const fixture = runSummaryConverter(rows as string[]);
    try {
      expect(() => execFileSync(
        process.execPath,
        [path.join(root, summaryPath), fixture.tsv, fixture.json, fixture.sha],
        { cwd: root, stdio: 'pipe' },
      )).toThrow();
    } finally {
      fs.rmSync(fixture.temp, { recursive: true, force: true });
    }
  });

  it('writes upload-friendly Markdown plus raw and structured artifacts', () => {
    const wrapper = read(wrapperPath);
    expect(wrapper).toContain('VBot-FULL-REPO-AUDIT.md');
    expect(wrapper).toContain('full-console.log');
    expect(wrapper).toContain('summary.json');
    expect(wrapper).toContain('summary.tsv');
    expect(wrapper).toContain('failures.txt');
    expect(wrapper).toContain('warnings.txt');
    expect(wrapper).toContain('## Host-Wrapper');
    expect(wrapper).toContain('## Innerer Collect-All-Runner des geprüften SHA');
    expect(wrapper).toContain('## Summary-Konverter des geprüften SHA');
  });

  it('writes final artifact and exit lines before snapshotting the complete console log', () => {
    const wrapper = read(wrapperPath);
    const finalOutputIndex = wrapper.indexOf("printf '\\n===== AUDIT OUTPUT =====\\n'");
    const reportFunctionIndex = wrapper.indexOf('make_report() {');
    expect(finalOutputIndex).toBeGreaterThan(-1);
    expect(reportFunctionIndex).toBeGreaterThan(finalOutputIndex);
  });

  it('keeps both Linux shell entrypoints syntactically valid on Unix CI', () => {
    if (process.platform === 'win32') return;
    for (const script of [collectorPath, wrapperPath]) {
      execFileSync('bash', ['-n', path.join(root, script)], {
        cwd: root,
        stdio: 'pipe',
      });
    }
  });
});
