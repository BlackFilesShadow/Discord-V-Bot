import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');
const read = (relativePath: string): string => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

describe('Radar auto-ban poll fallback regression gate', () => {
  it('does not lower Nitrado/worker polling intervals to gain speed', () => {
    expect(read('src/modules/nitrado/adm/admLiveSyncCron.ts')).toContain('const POLL_INTERVAL_MS = 30_000;');
    expect(read('src/modules/radar/runtime.ts')).toContain('const POLL_INTERVAL_MS = 15_000;');
    expect(read('src/modules/radar/autoBanRuntime.ts')).toContain('const POLL_INTERVAL_MS = 15_000;');
    expect(read('src/modules/nitrado/jobWorker.ts')).toContain('const JOB_POLL_INTERVAL_MS = 10_000;');
  });
});
