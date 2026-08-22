import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const auditDir = path.join(root, 'docs', 'audit');

const jsonEvidence = [
  'docs/dashboard-api-authentication-matrix.json',
  'docs/dashboard-api-authorization-scope-idor-matrix.json',
  'docs/dashboard-api-validation-race-idempotency-matrix.json',
  'docs/roles-permission-attack-matrix.json',
  'docs/csrf-xss-matrix.json',
  'docs/session-oauth-security-matrix.json',
  'docs/ssrf-injection-path-traversal-matrix.json',
  'docs/upload-webhook-security-matrix.json',
  'docs/audit/stage-matrix-1-67.json',
  'docs/audit/masterplan-audit-summary.json',
];

function read(relative: string): string {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

describe('Masterplan 1-67 audit artifact integrity', () => {
  it('has one deterministic generator and no derived-artifact drift', () => {
    const result = spawnSync(process.execPath, ['scripts/sync-masterplan-audit.mjs', '--check'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
    expect(result.stdout).toContain('Audit artifacts consistent');
  });

  it('keeps all security/audit JSON valid UTF-8 without BOM', () => {
    for (const relative of jsonEvidence) {
      const bytes = fs.readFileSync(path.join(root, relative));
      expect([...bytes.subarray(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf]);
      expect(() => JSON.parse(bytes.toString('utf8'))).not.toThrow();
    }
  });

  it('derives identical 67-stage counts in matrix, summary, scoreboard and report', () => {
    const matrix = JSON.parse(read('docs/audit/stage-matrix-1-67.json')) as {
      stages: Array<{ id: number; name: string; status: string }>;
      counts: Record<string, number>;
    };
    const summary = JSON.parse(read('docs/audit/masterplan-audit-summary.json')) as {
      stagesTotal: number;
      counts: Record<string, number>;
    };
    const rows = read('docs/audit/scoreboard-1-67.csv').trimEnd().split('\n');
    const report = read('docs/audit/MASTERPLAN-AUDIT-FINAL-REPORT.md');

    expect(matrix.stages.map(stage => stage.id)).toEqual(Array.from({ length: 67 }, (_, i) => i + 1));
    expect(Object.values(matrix.counts).reduce((sum, count) => sum + count, 0)).toBe(67);
    expect(summary).toMatchObject({ stagesTotal: 67, counts: matrix.counts });
    expect(rows).toHaveLength(68);
    expect(rows[0]).toBe('stage,status,name');

    const scoreboardCounts: Record<string, number> = {
      VERIFIED: 0,
      PARTIAL: 0,
      FAILED: 0,
      BLOCKED: 0,
    };
    for (const row of rows.slice(1)) {
      const status = row.split(',', 3)[1];
      scoreboardCounts[status] = (scoreboardCounts[status] ?? 0) + 1;
    }
    expect(scoreboardCounts).toEqual(matrix.counts);
    for (const [status, count] of Object.entries(matrix.counts)) {
      expect(report).toContain(`| ${status} | ${count} |`);
    }
    expect(report).toContain('| **TOTAL** | **67** |');
  });

  it('keeps the obsolete PowerShell writers disabled or delegated', () => {
    const aggregate = fs.readFileSync(path.join(auditDir, '_step6_aggregate.ps1'), 'utf8');
    expect(aggregate).toContain('sync-masterplan-audit.mjs');
    for (const file of ['_gen-stage-matrix.ps1', '_step3_update_matrix.ps1', '_step4_update_matrix.ps1']) {
      expect(fs.readFileSync(path.join(auditDir, file), 'utf8')).toContain('HISTORICAL_AUDIT_SCRIPT_DISABLED');
    }
  });
});
