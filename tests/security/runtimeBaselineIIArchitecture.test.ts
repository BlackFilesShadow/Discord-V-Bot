import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const m = JSON.parse(fs.readFileSync(path.resolve('docs/runtime-baseline-ii-matrix.json'), 'utf8')) as {
  stage: number;
  status: string;
  exactSha: string;
  residual: string[];
  verification: { artifacts: string[]; ciEvidence: string };
};

describe('Stage 47 runtime baseline II', () => {
  it('documents stage and runs structural harness', () => {
    expect(m.stage).toBe(47);
    const raw = execFileSync(process.execPath, ['scripts/runtime-baseline-ii-check.mjs'], { encoding: 'utf8' });
    const data = JSON.parse(raw);
    expect(data.prismaSingleton).toBe(true);
    expect(data.redisConfiguredInEnvExample).toBe(true);
    expect(data.nitradoJobModel).toBe(true);
    expect(m.status).toBe('VERIFIED');
    expect(m.exactSha).toMatch(/^[0-9a-f]{40}$/);
    expect(m.residual).toEqual([]);
    expect(m.verification.artifacts).toHaveLength(2);
    for (const artifact of m.verification.artifacts) {
      const evidence = JSON.parse(fs.readFileSync(path.resolve(artifact), 'utf8')) as {
        exactSha: string;
        requiredLive: boolean;
        residual: string[];
      };
      expect(evidence).toMatchObject({ exactSha: m.exactSha, requiredLive: true, residual: [] });
    }
    expect(fs.existsSync(path.resolve(m.verification.ciEvidence))).toBe(true);
  });
});
