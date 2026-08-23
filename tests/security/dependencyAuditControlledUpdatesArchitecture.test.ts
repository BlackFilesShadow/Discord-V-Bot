import fs from 'node:fs';
import path from 'node:path';

const m = JSON.parse(fs.readFileSync(path.resolve('docs/dependency-audit-controlled-updates-matrix.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'));

describe('Stage 53 dependency audit controlled updates', () => {
  it('binds dependency-control evidence to the current audited main and lockfile', () => {
    expect(m.stage).toBe(53);
    expect(m.schemaVersion).toBeGreaterThanOrEqual(3);
    expect(m.basedOnMainSha).toMatch(/^[0-9a-f]{40}$/);
    expect(m.decision).toMatch(/No bulk dependency upgrades/);
    expect(m.contracts.noBlind).toMatch(/No bulk or major upgrade/);
    expect(fs.existsSync(path.resolve('package-lock.json'))).toBe(true);
  });

  it('pins current security-relevant manifest facts instead of relying on stale prose', () => {
    expect(pkg.engines?.node).toBe(m.currentFacts.nodeEngine);
    expect(pkg.overrides?.['deepmerge-ts']).toBe(m.currentFacts.deepmergeTsOverride);
    expect(Boolean(pkg.dependencies?.['passport-discord'])).toBe(m.currentFacts.passportDiscordDirectPresent);
    expect(Boolean(pkg.dependencies?.passport)).toBe(m.currentFacts.passportDirectPresent);
    expect(pkg.dependencies?.prisma).toBe(m.currentFacts.prismaDeclared);
    expect(pkg.dependencies?.['@prisma/client']).toBe(m.currentFacts.prismaClientDeclared);
  });

  it('keeps dependency follow-ups isolated by coupling boundary', () => {
    expect(m.completedFollowups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stage: 54, subject: 'passport-discord/passport' }),
        expect.objectContaining({ stage: 55, subject: 'inflight/glob transitive chain' }),
        expect.objectContaining({ stage: 56, subject: 'dashboard bundle' }),
      ]),
    );
    expect(m.contracts.securityGate).toMatch(/blocking/);
    expect(m.contracts.sbomGate).toMatch(/fail-closed/);
    expect(m.contracts.shaRule).toMatch(/0\/1/);
  });
});
