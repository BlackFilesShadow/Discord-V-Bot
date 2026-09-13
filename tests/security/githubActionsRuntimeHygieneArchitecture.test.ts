import fs from 'node:fs';
import path from 'node:path';
import { normalizeSourceNewlines } from '../helpers/sourceText';

const read = (relative: string) =>
  normalizeSourceNewlines(fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8'));

const ACTIVE_WORKFLOWS = [
  '.github/workflows/ci.yml',
  '.github/workflows/verification2.yml',
  '.github/workflows/e2e.yml',
  '.github/workflows/stage51-soak.yml',
  '.github/workflows/stage56-bundle.yml',
  '.github/workflows/stage59-chaos.yml',
] as const;

const refs = (source: string, action: string) =>
  [...source.matchAll(new RegExp(`uses:\\s*${action.replace('/', '\\/')}@(v\\d+)`, 'g'))].map((match) => match[1]);

describe('GitHub Actions runtime hygiene', () => {
  it('pins active workflows to the reviewed Node 24 action majors', () => {
    for (const workflow of ACTIVE_WORKFLOWS) {
      const source = read(workflow);

      const setupNodeRefs = refs(source, 'actions/setup-node');
      const uploadArtifactRefs = refs(source, 'actions/upload-artifact');
      const cacheRefs = refs(source, 'actions/cache');

      expect(setupNodeRefs.length).toBeGreaterThan(0);
      expect(setupNodeRefs.every((version) => version === 'v7')).toBe(true);
      expect(uploadArtifactRefs.length).toBeGreaterThan(0);
      expect(uploadArtifactRefs.every((version) => version === 'v7')).toBe(true);
      expect(cacheRefs.every((version) => version === 'v6')).toBe(true);
      expect(source).not.toContain('FORCE_JAVASCRIPT_ACTIONS_TO_NODE24');
    }
  });

  it('keeps the one-off final dependency hardening workflow outside the active runtime gate', () => {
    expect(ACTIVE_WORKFLOWS).not.toContain('.github/workflows/final-dependency-hardening.yml' as never);
  });

  it('does not weaken itself with skipped or focused tests', () => {
    const self = read('tests/security/githubActionsRuntimeHygieneArchitecture.test.ts');
    expect(self).not.toMatch(/test\.(only|skip)|describe\.(only|skip)/);
  });
});
