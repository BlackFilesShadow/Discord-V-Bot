import fs from 'node:fs';
import path from 'node:path';

const r = (p: string) => fs.readFileSync(path.resolve(process.cwd(), p), 'utf8');
const m = JSON.parse(r('docs/gesamtaudit-3-production-reality-matrix.json')) as {
  stage: number;
  cases: Array<{ id: string; status: string }>;
};
const env = r('.env.example');
const docker = r('Dockerfile');
const ci = r('.github/workflows/ci.yml');
const server = r('src/dashboard/server.ts');

describe('Stage 62 gesamtaudit 3 production reality', () => {
  it('keeps deploy surfaces and safe defaults', () => {
    expect(m.stage).toBe(62);
    expect(fs.existsSync(path.resolve('Dockerfile'))).toBe(true);
    expect(fs.existsSync(path.resolve('docker-compose.yml'))).toBe(true);
    expect(fs.existsSync(path.resolve('deploy'))).toBe(true);
    expect(env).toContain('METRICS_ENABLED=false');
    expect(env).toContain('SESSION_SECRET=');
    expect(env).toMatch(/ENCRYPTION_KEY=/);
    expect(docker).not.toMatch(/COPY\s+\.env\b/);
    expect(m.cases.some((c) => c.id === 'live-production-deploy' && c.status === 'residual-stage-67')).toBe(
      true,
    );
    expect(r('tests/security/gesamtaudit3ProductionRealityArchitecture.test.ts')).not.toMatch(
      /test\.(only|skip)|describe\.(only|skip)/,
    );
  });

  it('pins CI security fail-closed and health surface', () => {
    expect(ci).toMatch(/Root npm audit \(high blocking\)/);
    expect(ci).toMatch(/Generate SBOMs \(CycloneDX, blocking\)/);
    expect(ci).toMatch(/if-no-files-found:\s*error/);
    expect(server).toMatch(/health|ready/i);
  });
});
