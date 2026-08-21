import fs from 'node:fs';
import { normalizeSourceNewlines } from '../helpers/sourceText';
import path from 'node:path';

const read = (relative: string) => normalizeSourceNewlines(fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8'));

const matrix = JSON.parse(read('docs/dashboard-mobile-320-matrix.json')) as {
  stage: number;
  viewport: { width: number };
  checks: Array<{ id: string; e2e: string; status: string }>;
  surfaces: Array<{ id: string; route: string; status: string }>;
};
const mobileSpec = read('dashboard-ui/e2e/mobile.spec.ts');
const pageMatrix = read('dashboard-ui/e2e/dashboard-authenticated-page-matrix.spec.ts');
const botAdminMobile = read('dashboard-ui/e2e/bot-admin-mobile-contract.spec.ts');

describe('Stage 31 dashboard mobile 320px matrix', () => {
  it('documents 320px viewport inventory', () => {
    expect(matrix.stage).toBe(31);
    expect(matrix.viewport.width).toBe(320);
    expect(matrix.checks.length).toBeGreaterThanOrEqual(5);
    expect(matrix.surfaces.length).toBeGreaterThanOrEqual(6);
  });

  it('binds Playwright evidence for 320px overflow and touch targets', () => {
    expect(mobileSpec).toContain('width: 320');
    expect(mobileSpec).toContain('toBeGreaterThanOrEqual(44)');
    expect(pageMatrix).toContain('width: 320');
    expect(pageMatrix).toContain('Authenticated mobile viewport matrix');
    expect(botAdminMobile.length).toBeGreaterThan(100);
  });
});
