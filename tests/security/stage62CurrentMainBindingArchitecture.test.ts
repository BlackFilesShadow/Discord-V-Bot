import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

describe('Stage 62 current-main binding architecture', () => {
  it('pins production-reality evidence to the Stage-61 merge SHA and preserves deploy/security surfaces', () => {
    const matrix = JSON.parse(read('docs/gesamtaudit-3-production-reality-matrix.json')) as {
      stage: number;
      basedOnMainSha: string;
      status: string;
      contracts: Record<string, string>;
      cases: Array<{ id: string; status: string }>;
      residual: string[];
    };

    expect(matrix.stage).toBe(62);
    expect(matrix.basedOnMainSha).toBe('09adf32fbf5d06e0102634cec53ada3abd7ebe0d');
    expect(matrix.status).toBe('PARTIAL');
    expect(matrix.contracts.currentMainBinding).toMatch(/exact current main SHA/i);
    expect(matrix.cases.some((c) => c.id === 'current-main-exact-sha-binding' && c.status === 'runtime-verified')).toBe(true);

    for (const p of ['Dockerfile', 'docker-compose.yml', 'deploy', '.env.example', '.github/workflows/ci.yml']) {
      expect(fs.existsSync(path.join(root, p))).toBe(true);
    }

    expect(read('Dockerfile')).not.toMatch(/COPY\s+\.env\b/);
    expect(read('.env.example')).toContain('METRICS_ENABLED=false');
    expect(matrix.residual.join(' ')).toMatch(/final deploy|staging credentials/i);
  });
});
