import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const r = (p: string) => fs.readFileSync(path.resolve(process.cwd(), p), 'utf8');
const m = JSON.parse(r('docs/dashboard-bundle-codesplit-matrix.json')) as {
  stage: number;
  schemaVersion: number;
  status: string;
  basedOnMainSha: string;
  contracts: Record<string, string>;
  cases: Array<{ id: string }>;
  currentEvidence: {
    exactSha: string;
    measure: string;
    entryKb: number;
    maxChunkKb: number;
    over500kb: string[];
    measureExitCode: number;
  };
  residual: string[];
};
const app = r('dashboard-ui/src/App.tsx');
const vite = r('dashboard-ui/vite.config.ts');
const slugs = r('dashboard-ui/src/lib/devToolSlugs.ts');
const catalog = r('dashboard-ui/src/lib/devToolsCatalog.ts');
const dashboardPackage = r('dashboard-ui/package.json');
const stage56Workflow = r('.github/workflows/stage56-bundle.yml');
const zoneRadarTab = r('dashboard-ui/src/components/radar/ZoneRadarTab.tsx');
const zoneEditor = r('dashboard-ui/src/components/radar/ZoneEditor.tsx');

describe('Stage 56 dashboard bundle codesplit', () => {
  it('keeps the pre-remediation evidence truthful until the new exact-head gate completes', () => {
    expect(m.stage).toBe(56);
    expect(m.schemaVersion).toBeGreaterThanOrEqual(4);
    expect(m.status).toBe('PARTIAL');
    expect(m.currentEvidence).toMatchObject({
      exactSha: m.basedOnMainSha,
      measureExitCode: 5,
    });
    expect(m.currentEvidence.over500kb).toEqual([expect.stringMatching(/^vendor-radar-map-.*\.js$/)]);
    expect(m.residual.length).toBeGreaterThan(0);
  });

  it('App lazy-loads DEV + heavy routes and avoids catalog icon import in entry', () => {
    expect(app).toContain('lazyPage');
    expect(app).toContain("import('./pages/dev/");
    expect(app).toContain("import('./pages/ServerSlotV3')");
    expect(app).toContain("import('./pages/BotAdmin')");
    expect(app).toContain("import('./pages/Dev')");
    expect(app).toContain('DEV_TOOL_SLUGS');
    expect(app).not.toMatch(/from ['"].*devToolsCatalog['"]/);
    expect(slugs).toContain('bot-status');
    expect(r('dashboard-ui/src/pages/ServerSlotV3.tsx')).toContain("import LegacyServerSlot from './ServerSlot'");
  });

  it('keeps MapLibre isolated behind lazy radar imports', () => {
    expect(vite).toContain("if (id.includes('maplibre-gl')) return 'vendor-radar-map'");
    expect(zoneRadarTab).toContain("lazy(async () => ({ default: (await import('./DayzRadarMap')).DayzRadarMap }))");
    expect(zoneEditor).toContain("lazy(async () => ({ default: (await import('./DayzRadarMap')).DayzRadarMap }))");
  });

  it('runs the Stage 56 budget from normal dashboard builds and exact-SHA CI', () => {
    expect(dashboardPackage).toContain('node scripts/measure-dashboard-bundle.mjs');
    expect(stage56Workflow).toContain('STAGE56_EXACT_SHA: ${{ github.event.pull_request.head.sha || github.sha }}');
    expect(stage56Workflow).toContain('STAGE56_OUTPUT_PATH: stage56-artifacts/');
    expect(stage56Workflow).toContain('Upload Stage 56 exact-SHA evidence');
  });

  it('measure script enforces normal + lazy MapLibre raw/gzip budgets', () => {
    const script = r('scripts/measure-dashboard-bundle.mjs');
    expect(script).toContain('NORMAL_CHUNK_LIMIT_BYTES = 500 * 1024');
    expect(script).toContain('RADAR_VENDOR_RAW_LIMIT_BYTES = 1024 * 1024');
    expect(script).toContain('RADAR_VENDOR_GZIP_LIMIT_BYTES = 300 * 1024');
    expect(script).toContain('event?.pull_request?.head?.sha');
    expect(script).toContain('nonRadarChunksUnder500kb');
    expect(script).toContain('singleLazyRadarVendor');
    expect(script).toContain('radarVendorRawUnder1MiB');
    expect(script).toContain('radarVendorGzipUnder300KiB');

    const assets = path.resolve('src/dashboard/public/assets');
    if (!fs.existsSync(assets)) return;

    const exactSha = '1111111111111111111111111111111111111111';
    const result = spawnSync(process.execPath, ['scripts/measure-dashboard-bundle.mjs'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        WRITE_PERF_ARTIFACTS: '0',
        GITHUB_ACTIONS: 'false',
        STAGE56_EXACT_SHA: exactSha,
      },
    });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const raw = result.stdout;
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    const data = JSON.parse(raw.slice(start, end + 1)) as {
      exactSha: string;
      budgets: {
        normalChunkRawKiB: number;
        radarVendorRawKiB: number;
        radarVendorGzipKiB: number;
      };
      radarVendors: Array<{ name: string; kb: number; gzipKb: number }>;
      oversizedNonRadar: string[];
      contracts: Record<string, boolean>;
    };
    expect(data.exactSha).toBe(exactSha);
    expect(data.budgets).toEqual({
      normalChunkRawKiB: 500,
      radarVendorRawKiB: 1024,
      radarVendorGzipKiB: 300,
    });
    expect(data.oversizedNonRadar).toEqual([]);
    expect(data.radarVendors).toHaveLength(1);
    expect(data.radarVendors[0].name).toMatch(/^vendor-radar-map-.*\.js$/);
    expect(data.radarVendors[0].kb).toBeLessThan(1024);
    expect(data.radarVendors[0].gzipKb).toBeLessThan(300);
    expect(data.contracts).toMatchObject({
      entryUnder500kb: true,
      nonRadarChunksUnder500kb: true,
      singleLazyRadarVendor: true,
      radarVendorRawUnder1MiB: true,
      radarVendorGzipUnder300KiB: true,
      hasVendorSplit: true,
    });
  });

  it('DEV_TOOL_SLUGS stays in parity with DEV_TOOLS catalog slugs', () => {
    const slugList = [...slugs.matchAll(/'([a-z0-9-]+)'/g)].map((x) => x[1]);
    const catalogSlugs = [...catalog.matchAll(/slug:\s*'([a-z0-9-]+)'/g)].map((x) => x[1]);
    expect(slugList.sort()).toEqual(catalogSlugs.sort());
  });
});
