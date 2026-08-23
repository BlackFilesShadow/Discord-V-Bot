import fs from 'node:fs';
import path from 'node:path';

const matrix = JSON.parse(
  fs.readFileSync(path.resolve('docs/dependency-audit-controlled-updates-matrix.json'), 'utf8'),
);
const pkg = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.resolve('package-lock.json'), 'utf8'));

describe('Stage 53 dependency audit controlled updates', () => {
  it('binds the dependency decision to the current audited main baseline', () => {
    expect(matrix.stage).toBe(53);
    expect(matrix.basedOnMainSha).toBe('7b66cc4bb1b96dec9125375d7790389e59fa697d');
    expect(matrix.decision).toMatch(/No bulk dependency upgrades/);
  });

  it('keeps the lockfile and controlled runtime dependency contracts', () => {
    expect(lock.lockfileVersion).toBe(3);
    expect(pkg.engines?.node).toBe('>=22.0.0');
    expect(pkg.overrides?.['deepmerge-ts']).toBe('8.0.2');
    expect(pkg.dependencies?.['@prisma/client']).toMatch(/^\^7\.8\./);
    expect(pkg.dependencies?.['@prisma/adapter-pg']).toMatch(/^\^7\.8\./);
    expect(pkg.dependencies?.prisma).toMatch(/^\^7\.8\./);
  });

  it('does not reintroduce the retired passport stack', () => {
    for (const name of ['passport', 'passport-discord', '@types/passport', '@types/passport-discord']) {
      expect(pkg.dependencies?.[name]).toBeUndefined();
      expect(pkg.devDependencies?.[name]).toBeUndefined();
    }
  });
});
