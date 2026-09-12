import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const auditDir = path.join(root, 'docs', 'audit');
const stageEvidenceSources = new Map([
  [46, 'docs/runtime-baseline-i-matrix.json'],
  [47, 'docs/runtime-baseline-ii-matrix.json'],
  [48, 'docs/ai-nitrado-performance-baseline-matrix.json'],
  [49, 'docs/memory-leak-audit-matrix.json'],
  [50, 'docs/load-test-matrix.json'],
  [51, 'docs/soak-test-matrix.json'],
  [52, 'docs/ram-node-heap-tuning-matrix.json'],
  [56, 'docs/dashboard-bundle-codesplit-matrix.json'],
  [57, 'docs/dead-code-legacy-cleanup-matrix.json'],
  [58, 'docs/full-user-journey-e2e-matrix.json'],
  [59, 'docs/chaos-test-matrix.json'],
  [60, 'docs/gesamtaudit-1-code-architecture-matrix.json'],
  [61, 'docs/gesamtaudit-2-couplings-matrix.json'],
  [62, 'docs/gesamtaudit-3-production-reality-matrix.json'],
]);

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

  it('keeps late-stage canonical status aligned with its evidence matrix', () => {
    const matrix = JSON.parse(read('docs/audit/stage-matrix-1-67.json')) as {
      stages: Array<{ id: number; status: string; evidence: string[]; findings: string[] }>;
    };

    for (const [stageId, relativePath] of stageEvidenceSources) {
      const evidence = JSON.parse(read(relativePath)) as {
        stage: number;
        status: string;
        residual: string[];
      };
      const canonical = matrix.stages.find(stage => stage.id === stageId);
      expect(evidence.stage).toBe(stageId);
      expect(canonical).toMatchObject({ status: evidence.status });
      expect(canonical?.evidence).toContain(relativePath);
      if (evidence.status === 'VERIFIED') {
        expect(evidence.residual).toEqual([]);
        expect(canonical?.findings).toEqual([]);
      } else {
        expect(evidence.residual.length).toBeGreaterThan(0);
        expect(canonical?.findings.length).toBeGreaterThan(0);
      }
    }
  });

  it('keeps the obsolete PowerShell writers disabled or delegated', () => {
    const aggregate = fs.readFileSync(path.join(auditDir, '_step6_aggregate.ps1'), 'utf8');
    expect(aggregate).toContain('sync-masterplan-audit.mjs');
    for (const file of ['_gen-stage-matrix.ps1', '_step3_update_matrix.ps1', '_step4_update_matrix.ps1']) {
      expect(fs.readFileSync(path.join(auditDir, file), 'utf8')).toContain('HISTORICAL_AUDIT_SCRIPT_DISABLED');
    }
  });
});
