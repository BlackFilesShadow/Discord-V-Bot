import fs from 'node:fs';
import path from 'node:path';

const m = JSON.parse(fs.readFileSync(path.resolve('docs/dashboard-bundle-codesplit-matrix.json'), 'utf8'));
const app = fs.readFileSync(path.resolve('dashboard-ui/src/App.tsx'), 'utf8');
const vite = fs.existsSync(path.resolve('dashboard-ui/vite.config.ts'))
  ? fs.readFileSync(path.resolve('dashboard-ui/vite.config.ts'), 'utf8')
  : fs.readFileSync(path.resolve('dashboard-ui/vite.config.mts'), 'utf8');

describe('Stage 56 dashboard bundle codesplit', () => {
  it('uses lazy routes for DEV pages', () => {
    expect(m.stage).toBe(56);
    expect(app).toContain('lazy(');
    expect(app).toContain('lazyPage');
    expect(app).toContain('DEV_PAGES');
    expect(app).toContain("import('./pages/dev/");
    expect(vite.length).toBeGreaterThan(50);
  });
});
