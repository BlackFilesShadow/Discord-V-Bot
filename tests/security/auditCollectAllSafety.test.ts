import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeSourceNewlines } from '../helpers/sourceText';

const root = process.cwd();
const read = (relative: string): string =>
  normalizeSourceNewlines(fs.readFileSync(path.join(root, relative), 'utf8'));

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
    expect(collector).toContain("run_step 'jest-ci'");
    expect(collector).toContain("run_step 'playwright-real-db'");
    expect(collector).toContain("run_step 'players-4000'");
    expect(collector).not.toContain('set -euo pipefail');
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

  it('converts the TSV block result into deterministic machine-readable JSON', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'vbot-audit-summary-'));
    const tsv = path.join(temp, 'summary.tsv');
    const json = path.join(temp, 'summary.json');
    const sha = '0123456789abcdef0123456789abcdef01234567';
    fs.writeFileSync(
      tsv,
      [
        'step\tstatus\tclassification\texitCode\twarningLines\tdurationSec\tlog',
        'lint-all\tPASS\tOK\t0\t2\t10\t/audit-output/logs/lint-all.log',
        'db-consistency\tFAIL\tECHTER FEHLER\t1\t0\t3\t/audit-output/logs/db-consistency.log',
        'players-4000\tSKIPPED\tFOLGEFEHLER\t-\t0\t0\t-',
        '',
      ].join('\n'),
      'utf8',
    );

    try {
      execFileSync(process.execPath, [path.join(root, summaryPath), tsv, json, sha], {
        cwd: root,
        stdio: 'pipe',
      });
      const parsed = JSON.parse(fs.readFileSync(json, 'utf8')) as {
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
      expect(parsed.sha).toBe(sha);
      expect(parsed.allGreen).toBe(false);
      expect(parsed.totals).toEqual({
        steps: 3,
        passed: 1,
        failed: 1,
        skippedFollowups: 1,
        warningCandidates: 2,
      });
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
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
