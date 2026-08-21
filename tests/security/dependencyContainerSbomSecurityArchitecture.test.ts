import fs from 'node:fs';
import path from 'node:path';

const r = (p: string) => fs.readFileSync(path.resolve(process.cwd(), p), 'utf8');
const m = JSON.parse(r('docs/dependency-container-sbom-security-matrix.json')) as { stage: number };
const docker = r('Dockerfile');

describe('Stage 45 dependency container SBOM security', () => {
  it('documents stage', () => {
    expect(m.stage).toBe(45);
  });

  it('Dockerfile does not copy .env and lockfile exists', () => {
    expect(docker).not.toMatch(/COPY\s+\.env\b/);
    expect(fs.existsSync(path.resolve(process.cwd(), 'package-lock.json'))).toBe(true);
  });
});
