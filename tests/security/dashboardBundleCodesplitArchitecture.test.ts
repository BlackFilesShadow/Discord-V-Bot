import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const r = (p: string) => fs.readFileSync(path.resolve(process.cwd(), p), 'utf8');
const m = JSON.parse(r('docs/dashboard-bundle-codesplit-matrix.json')) as {
  stage: number;
  schemaVersion: number;
  basedOnMainSha: string;
  contracts: Record<string, string>;
  cases: Array<{ id: string }>;
};
const app = r('dashboard-ui/src/App.tsx');
const vite = r('dashboard-ui/vite.config.ts');
const slugs = r('dashboard-ui/src/lib/devToolSlugs.ts');
const catalog = r('dashboard-ui/src/lib/devToolsCatalog.ts');

describe('Stage 56 dashboard bundle codesplit', () => {
  it('documents measured split contracts on the current main base', () => {
    expect(m.stage).toBe(56);
    expect(m.schemaVersion).toBeGreaterThanOrEqual(3);
    expect(m.basedOnMainSha).toBe('69caddd756bdb5e7f3cc5618d2e12e130c3705fd');
    expect(m.cases.map((c) => c.id)).toEqual(
      expect.arrayContaining([
        'entry-under-500kb',
        'all-chunks-under-500kb',
        'vendor-manual-chunks',
        'dev-route-lazy',
      ]),
    );
    expect(m.contracts.manualChunks).toMatch(/vendor-react/);
    expect(m.contracts.gateRule).toMatch(/one complete CI\/CD \+ Verification 2 \+ Playwright cycle/);
    expect(r('tests/security/dashboardBundleCodesplitArchitecture.test.ts')).not.toMatch(
      /test\.(only|skip)|describe\.(only|skip)/,
    );
  });

  it('App lazy-loads DEV + heavy routes and avoids catalog icon import in entry', () => {
    expect(app).toContain('lazyPage');
    expect(app).toContain("import('./pages/dev/");
    expect(app).toContain("import('./pages/ServerSlot')");
    expect(app).toContain("import('./pages/BotAdmin')");
    expect(app).toContain("import('./pages/Dev')");
    expect(app).toContain('DEV_TOOL_SLUGS');
    expect(app).not.toMatch(/from ['"].*devToolsCatalog['"]/);
    expect(slugs).toContain('bot-status');
  });

  it('vite manualChunks splits major vendors', () => {
    expect(vite).toContain('manualChunks');
    expect(vite).toContain('vendor-react');
    expect(vite).toContain('vendor-router');
    expect(vite).toContain('vendor-lucide');
  });

  it('DEV_TOOL_SLUGS stays in parity with DEV_TOOLS catalog slugs', () => {
    const slugList = [...slugs.matchAll(/'([a-z0-9-]+)'/g)].map((x) => x[1]);
    const catalogSlugs = [...catalog.matchAll(/slug:\s*'([a-z0-9-]+)'/g)].map((x) => x[1]);
    expect(slugList.sort()).toEqual(catalogSlugs.sort());
  });

  it('measure script enforces every emitted JS chunk <500kB when assets present', () => {
    const assets = path.resolve('src/dashboard/public/assets');
    if (!fs.existsSync(assets)) {
      const script = r('scripts/measure-dashboard-bundle.mjs');
      expect(script).toContain('entryUnder500kb');
      expect(script).toContain('allChunksUnder500kb');
      expect(script).toContain('over500.length === 0');
      expect(script).toContain('500 * 1024');
      return;
    }
    const raw = execFileSync(process.execPath, ['scripts/measure-dashboard-bundle.mjs'], {
      encoding: 'utf8',
      env: { ...process.env, WRITE_PERF_ARTIFACTS: '0' },
    });
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    const data = JSON.parse(raw.slice(start, end + 1)) as {
      contracts: {
        entryUnder500kb: boolean;
        allChunksUnder500kb: boolean;
        hasVendorSplit: boolean;
      };
      entry: { kb: number };
      over500kb: string[];
    };
    expect(data.contracts.entryUnder500kb).toBe(true);
    expect(data.contracts.allChunksUnder500kb).toBe(true);
    expect(data.contracts.hasVendorSplit).toBe(true);
    expect(data.entry.kb).toBeLessThan(500);
    expect(data.over500kb).toEqual([]);
  });
});
