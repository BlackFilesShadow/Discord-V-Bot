import fs from 'node:fs';
import path from 'node:path';

const r = (p: string) => fs.readFileSync(path.resolve(process.cwd(), p), 'utf8');
const m = JSON.parse(r('docs/ssrf-injection-path-traversal-matrix.json')) as {
  stage: number;
  cases: Array<{ id: string }>;
};
const botAdmin = r('src/dashboard/routes/v2/botAdmin.ts');
const feeds = r('src/dashboard/routes/v2/feeds.ts');
const stubs = r('src/dashboard/routes/v2/devStubs.ts');
const server = r('src/dashboard/server.ts');
const ssrfRuntime = r('tests/security/ssrf.test.ts');
const pathRuntime = r('tests/security/pathSafetyBoundary.test.ts');
const uploadRuntime = r('tests/modules/safeUploadValidation.test.ts');
const sqlSurface = r('tests/security/sqlCommandInjectionSurfaceRuntime.test.ts');

describe('Stage 42 SSRF injection path traversal matrix', () => {
  it('documents stage', () => {
    expect(m.stage).toBe(42);
    expect(m.cases.map((c) => c.id)).toEqual(
      expect.arrayContaining([
        'raw-sql-no-untrusted-interpolation',
        'no-dynamic-shell-exec',
        'feed-ssrf-block',
      ]),
    );
  });

  it('blocks private hosts and hardens sensitive filesystem paths', () => {
    expect(botAdmin + feeds).toContain('isBlockedHost');
    expect(stubs).toMatch(/writeHeapSnapshot|heap-snapshot/);
    expect(server).toContain('/uploads/factions');
    expect(server).toContain('/uploads/media');
    expect(server).not.toContain("express.static(config.upload.dir");
  });

  it('pins Stage 42 SSRF + path-traversal + SQL surface runtime negative evidence', () => {
    expect(ssrfRuntime).toContain("'169.254.169.254'");
    expect(ssrfRuntime).toContain("it.each(blocked)");
    expect(ssrfRuntime).toContain("lehnt nicht-http(s)-Protokolle ab");
    expect(pathRuntime).toContain('DENY classic traversal and sibling prefix spoof outside root');
    expect(uploadRuntime).toContain('blockiert manipulierte DB-Pfade ausserhalb des Upload-Root');
    expect(sqlSurface).toContain('first-arg SQL free of');
    expect(sqlSurface).toContain('child_process');
    expect(sqlSurface + ssrfRuntime + pathRuntime + uploadRuntime).not.toMatch(
      /test\.(only|skip)|describe\.(only|skip)/,
    );
  });
});
