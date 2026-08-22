import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const r = (p: string) => fs.readFileSync(path.resolve(process.cwd(), p), 'utf8');
const m = JSON.parse(r('docs/dependency-container-sbom-security-matrix.json')) as {
  stage: number;
  contracts: Record<string, string>;
  cases: Array<{ id: string; status: string }>;
  verification: {
    sbomBlocking: boolean;
    rootHighBlocking: boolean;
    overridePackage: string;
    overrideVersion: string;
  };
};
const docker = r('Dockerfile');
const pkg = JSON.parse(r('package.json')) as {
  overrides?: Record<string, string>;
  dependencies?: Record<string, string>;
};
const ci = r('.github/workflows/ci.yml');
const gate2 = r('.github/workflows/verification2.yml');

describe('Stage 45 dependency container SBOM security', () => {
  it('documents stage contracts and residual honesty', () => {
    expect(m.stage).toBe(45);
    expect(m.verification.sbomBlocking).toBe(true);
    expect(m.verification.rootHighBlocking).toBe(true);
    expect(m.contracts.sbom).toMatch(/blocking/i);
    expect(m.cases.map((c) => c.id)).toEqual(
      expect.arrayContaining([
        'root-audit-high-zero-via-override',
        'sbom-generation-blocking-ci',
        'deepmerge-ts-override-ge-8',
      ]),
    );
  });

  it('Dockerfile does not copy .env and lockfile exists', () => {
    expect(docker).not.toMatch(/COPY\s+\.env\b/);
    expect(fs.existsSync(path.resolve(process.cwd(), 'package-lock.json'))).toBe(true);
    expect(fs.existsSync(path.resolve(process.cwd(), 'dashboard-ui/package-lock.json'))).toBe(true);
  });

  it('pins deepmerge-ts override >=8 without prisma force-downgrade', () => {
    expect(pkg.overrides?.['deepmerge-ts']).toBe(m.verification.overrideVersion);
    const major = Number(String(pkg.overrides?.['deepmerge-ts']).split('.')[0]);
    expect(major).toBeGreaterThanOrEqual(8);
    expect(pkg.dependencies?.prisma).toMatch(/\^?7\./);
    const lock = r('package-lock.json');
    expect(lock).toMatch(/"deepmerge-ts"/);
    expect(lock).not.toMatch(/"node_modules\/deepmerge-ts"[\s\S]{0,80}"version": "7\./);
  });

  it('CI Security Audit keeps root high + SBOM fail-closed (no continue-on-error / non-blocking echo)', () => {
    expect(ci).toMatch(/Root npm audit \(high blocking\)/);
    const highBlock = ci.match(/- name: Root npm audit \(high blocking\)[\s\S]*?(?=\n\s+- name:)/)?.[0] ?? '';
    expect(highBlock).toContain('npm audit --audit-level=high');
    expect(highBlock).not.toMatch(/continue-on-error:\s*true/);

    const sbomBlock = ci.match(/- name: Generate SBOMs \(CycloneDX, blocking\)[\s\S]*?(?=\n\s+- name: Upload SBOM)/)?.[0] ?? '';
    expect(sbomBlock).toContain('set -euo pipefail');
    expect(sbomBlock).toContain('test -s sbom.cyclonedx.json');
    expect(sbomBlock).not.toMatch(/\|\|\s*echo/);
    expect(sbomBlock).not.toMatch(/non-blocking/);
    expect(ci).toMatch(/if-no-files-found:\s*error/);
  });

  it('Docker job builds image on every run and blocks Trivy CRITICAL findings', () => {
    expect(ci).toMatch(/name:\s*Docker Build/);
    // no longer main-only skip for the job itself
    const dockerJob = ci.match(/docker:\n[\s\S]*?(?=\n  main-gate-status:)/)?.[0] ?? '';
    expect(dockerJob).toContain('docker build -t discord-v-bot:');
    expect(dockerJob).not.toMatch(/if:\s*github\.ref == 'refs\/heads\/main'/);
    expect(dockerJob).toMatch(/Trivy image scan \(CRITICAL blocking\)/);
    expect(dockerJob).toMatch(/aquasecurity\/trivy-action@v0\./);
    expect(dockerJob).toMatch(/severity:\s*CRITICAL/);
    expect(dockerJob).toMatch(/exit-code:\s*'1'/);
    expect(dockerJob).toMatch(/Trivy image scan \(HIGH report\)/);
  });

  it('Gate 2 Security/SBOM is blocking for root high and SBOM artifacts', () => {
    expect(gate2).toMatch(/Generate SBOMs \(blocking\)/);
    const sbom2 = gate2.match(/- name: Generate SBOMs \(blocking\)[\s\S]*?(?=\n\s+- if: always\(\))/)?.[0] ?? '';
    expect(sbom2).toContain('set -euo pipefail');
    expect(sbom2).toContain('test -s sbom.cyclonedx.json');
    expect(sbom2).not.toMatch(/\|\|\s*echo/);
    expect(gate2).toMatch(/Root npm audit \(high blocking\)/);
    expect(gate2).toMatch(/if-no-files-found:\s*error/);
  });

  it('resolved production tree has deepmerge-ts >=8 and critical/high audit clean at root', () => {
    const ls = execSync('npm ls deepmerge-ts --json', { encoding: 'utf8' });
    expect(ls).toMatch(/"version": "8\./);
    execSync('npm audit --omit=dev --audit-level=high', { encoding: 'utf8', stdio: 'pipe' });
    execSync('npm audit --audit-level=critical', { encoding: 'utf8', stdio: 'pipe' });
  });

  it('passport-discord removed (Stage 54) and forbids skip/only', () => {
    expect(pkg.dependencies?.['passport-discord']).toBeUndefined();
    expect(pkg.dependencies?.passport).toBeUndefined();
    // Stage 45 residual case may still document historical tracking id — prefer removed
    const self = r('tests/security/dependencyContainerSbomSecurityArchitecture.test.ts');
    expect(self).not.toMatch(/test\.(only|skip)|describe\.(only|skip)/);
  });
});
