import fs from 'node:fs';
import path from 'node:path';

const read = (relative: string) => fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8');

interface DesktopMatrix {
  schemaVersion: number;
  stage: number;
  basedOnMainSha: string;
  surfaces: Array<{ id: string; route: string; e2e: string; status: string }>;
  desktopChecks: Array<{ id: string; evidence: string; status: string }>;
}

const matrix = JSON.parse(read('docs/dashboard-desktop-completion-matrix.json')) as DesktopMatrix;
const app = read('dashboard-ui/src/App.tsx');
const pageMatrix = read('dashboard-ui/e2e/dashboard-authenticated-page-matrix.spec.ts');
const loginSpec = read('dashboard-ui/e2e/login.spec.ts');

describe('Stage 30 dashboard desktop completion matrix', () => {
  it('documents core surfaces and desktop checks', () => {
    expect(matrix.stage).toBe(30);
    expect(matrix.schemaVersion).toBe(1);
    expect(matrix.surfaces.length).toBeGreaterThanOrEqual(6);
    expect(matrix.desktopChecks.length).toBeGreaterThanOrEqual(4);
    for (const surface of matrix.surfaces) {
      expect(surface.id.trim()).not.toBe('');
      expect(surface.route.trim()).not.toBe('');
      expect(surface.e2e.trim()).not.toBe('');
      expect(surface.status.trim()).not.toBe('');
    }
  });

  it('keeps App route table complete for production shells', () => {
    expect(app).toContain('path="/login"');
    expect(app).toContain('path="/servers"');
    expect(app).toContain('path="/servers/:guildId"');
    expect(app).toContain('path="/servers/:guildId/server/:slot"');
    expect(app).toContain('path="/bot-admin"');
    expect(app).toContain('path="/dev"');
    expect(app).toContain('DEV_PAGES');
    expect(app).toContain('DEV_TOOLS.filter');
  });

  it('binds desktop 1280 completion E2E and login evidence', () => {
    expect(pageMatrix).toContain("Desktop 1280 completion");
    expect(pageMatrix).toContain('width: 1280');
    expect(pageMatrix).toContain("toHaveAttribute('lang', 'de')");
    expect(pageMatrix).toContain('expectNoHorizontalOverflow');
    expect(loginSpec.length).toBeGreaterThan(100);
  });
});
