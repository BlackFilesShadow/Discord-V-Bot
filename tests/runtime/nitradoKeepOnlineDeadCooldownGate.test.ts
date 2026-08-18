import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const CRON_FILE = path.join(ROOT, 'src/modules/nitrado/permaOnlyCron.ts');
const JOBS_FILE = path.join(ROOT, 'src/modules/nitrado/keepOnlineJobs.ts');

function compact(source: string): string {
  return source.replace(/\s+/g, ' ');
}

describe('Nitrado-1H keep-online DEAD retry cooldown gate', () => {
  it('keeps a bounded cooldown for real DEAD auto-start failures', () => {
    const source = compact(fs.readFileSync(CRON_FILE, 'utf8'));

    expect(source).toContain('KEEP_ONLINE_DEAD_RETRY_COOLDOWN_MS = 60 * 60 * 1000');
    expect(source).toContain('deadCutoff = new Date(Date.now() - KEEP_ONLINE_DEAD_RETRY_COOLDOWN_MS)');
    expect(source).toContain("{ status: { in: ['PENDING', 'RUNNING'] } }");
    expect(source).toContain("status: 'DEAD'");
    expect(source).toContain('updatedAt: { gte: deadCutoff }');
  });

  it('does not treat deliberate keep-online disable cancellation as a retry failure', () => {
    const cronSource = compact(fs.readFileSync(CRON_FILE, 'utf8'));
    const jobsSource = compact(fs.readFileSync(JOBS_FILE, 'utf8'));

    expect(jobsSource).toContain("export const KEEP_ONLINE_DISABLED_JOB_REASON = 'Keep-Online deaktiviert; geplanter Auto-Start verworfen.'");
    expect(jobsSource).toContain('lastError: KEEP_ONLINE_DISABLED_JOB_REASON');
    expect(cronSource).toContain("import { KEEP_ONLINE_DISABLED_JOB_REASON } from './keepOnlineJobs'");
    expect(cronSource).toContain('NOT: { lastError: KEEP_ONLINE_DISABLED_JOB_REASON }');
  });

  it('checks active/recent-dead blockers before creating the next bounded job', () => {
    const source = compact(fs.readFileSync(CRON_FILE, 'utf8'));
    const blockerRead = source.indexOf('tx.nitradoJob.findFirst');
    const create = source.indexOf('tx.nitradoJob.create');

    expect(blockerRead).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(blockerRead);
    expect(source.slice(blockerRead, create)).toContain("operation: 'RESTART_IF_DOWN'");
    expect(source.slice(blockerRead, create)).toContain("status: 'DEAD'");
    expect(source.slice(create)).toContain('maxAttempts: 3');
  });
});
