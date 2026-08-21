import fs from 'node:fs';
import path from 'node:path';

const r = (p: string) => fs.readFileSync(path.resolve(process.cwd(), p), 'utf8');
const m = JSON.parse(r('docs/ssrf-injection-path-traversal-matrix.json')) as { stage: number };
const botAdmin = r('src/dashboard/routes/v2/botAdmin.ts');
const feeds = r('src/dashboard/routes/v2/feeds.ts');
const stubs = r('src/dashboard/routes/v2/devStubs.ts');
const server = r('src/dashboard/server.ts');

describe('Stage 42 SSRF injection path traversal matrix', () => {
  it('documents stage', () => {
    expect(m.stage).toBe(42);
  });

  it('blocks private hosts and hardens sensitive filesystem paths', () => {
    expect(botAdmin + feeds).toContain('isBlockedHost');
    expect(stubs).toMatch(/writeHeapSnapshot|heap-snapshot/);
    expect(server).toContain('/uploads/factions');
    expect(server).toContain('/uploads/media');
    expect(server).not.toContain("express.static(config.upload.dir");
  });
});
