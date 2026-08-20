import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');
const read = (file: string): string => fs.readFileSync(path.join(root, file), 'utf8');

describe('Dashboard-2C DEV diagnostics architecture', () => {
  const hook = read('dashboard-ui/src/lib/useDevStatus.ts');
  const live = read('dashboard-ui/src/pages/dev/LiveBotStatus.tsx');

  test('polling invalidates stale diagnostic data on every failed request', () => {
    expect(hook).toMatch(/\.catch\(e => \{[\s\S]*setData\(null\);[\s\S]*setError\(/);
    expect(hook).toMatch(/DEV_LOGIN_REQUIRED/);
    expect(hook).toMatch(/DEV_MFA_REQUIRED/);
    expect(hook).toMatch(/DEV_IP_DENIED/);
    expect(hook).toMatch(/setStopped\(true\)/);
  });

  test('live snapshot is runtime-validated and missing data is never reported as offline', () => {
    expect(live).toContain('function asSnapshot(value: unknown): Snapshot | null');
    expect(live).toContain("useDevStatus<unknown>('/api/v2/dev/snapshot', 5000)");
    expect(live).toContain('Ungültige Snapshot-Antwort. Diagnosewerte wurden verworfen.');
    expect(live).toMatch(/snap \? \(snap\.botReady \? 'online' : 'offline'\) : \(loading \? 'lädt…' : 'unbekannt'\)/);
    expect(live).toContain('role="alert"');
  });

  test('mobile diagnostic controls retain touch targets and log output cannot widen the page', () => {
    expect(live).toContain('min-h-11 min-w-11 sm:min-h-0 sm:min-w-0');
    expect(live).toContain('aria-label="Live-Logs durchsuchen"');
    expect(live).toContain('className="pl-7 h-11 sm:h-8 text-xs"');
    expect(live).toContain('max-w-full overflow-x-hidden overflow-y-auto');
    expect(live).toContain('break-all whitespace-pre-wrap min-w-0');
  });
});
