import fs from 'node:fs';
import path from 'node:path';
import { normalizeSourceNewlines } from '../helpers/sourceText';

const read = (relative: string): string => normalizeSourceNewlines(
  fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8'),
);

describe('Nitrado drift transient contention retry gate', () => {
  const retry = read('dashboard-ui/src/lib/nitradoDriftRetry.ts');
  const banner = read('dashboard-ui/src/components/NitradoDriftBanner.tsx');
  const route = read('src/dashboard/routes/v2/nitradoDrift.ts');
  const worker = read('src/modules/nitrado/jobWorker.ts');

  it('classifies only HTTP 409 binding-fence contention as transient', () => {
    expect(retry).toContain('if (error.status !== 409) return false;');
    expect(retry).toContain("'NITRADO_BINDING_BUSY'");
    expect(retry).toContain("'NITRADO_BINDING_STALE'");
    expect(retry).toContain('if (error.code && TRANSIENT_DRIFT_CODES.has(error.code)) return true;');
    expect(retry).toContain('TRANSIENT_DRIFT_MESSAGES.some(message => error.desc.startsWith(message))');

    // A semantically different 409 must never enter the transient allow-list.
    expect(route).toContain('Nitrado-Verbindung ist nicht ACTIVE oder besitzt keine Service-ID.');
    expect(retry).not.toContain('Nitrado-Verbindung ist nicht ACTIVE oder besitzt keine Service-ID.');
    expect(retry).not.toContain('Nitrado-Slot wurde parallel geaendert.');
  });

  it('pins the compatibility fallback to every currently deployed binding-fence message', () => {
    const messages = [
      'Nitrado-Verbindung wird gerade sicher verarbeitet oder parallel geaendert.',
      'Nitrado-Zuordnung hat sich waehrend der Drift-Pruefung geaendert.',
      'Nitrado-Zuordnung hat sich waehrend der Drift-Bestaetigung geaendert.',
    ];

    for (const message of messages) {
      expect(route).toContain(message);
      expect(retry).toContain(message);
    }
  });

  it('uses a bounded ~21 second backoff instead of unbounded polling', () => {
    expect(retry).toContain('NITRADO_DRIFT_RETRY_DELAYS_MS = [500, 1_500, 3_000, 6_000, 10_000]');
    expect(retry).toContain('failureCount < NITRADO_DRIFT_RETRY_DELAYS_MS.length');
    expect(retry).toContain('Math.max(0, attemptIndex)');
    expect(retry).toContain('NITRADO_DRIFT_RETRY_DELAYS_MS.length - 1');
    expect(retry).toContain('return NITRADO_DRIFT_RETRY_DELAYS_MS[boundedIndex];');
  });

  it('matches the real worker serialization boundary that can legitimately hold the lock across remote I/O', () => {
    const acquire = worker.indexOf('connectionLock = await tryAcquireConnectionLock(job.nitradoConnId);');
    const remoteClient = worker.indexOf('client = new NitradoClient(token);', acquire);
    const remoteWrite = worker.indexOf('await client.addToWhitelist(', remoteClient);
    const release = worker.indexOf('await connectionLock.release();', remoteWrite);

    expect(acquire).toBeGreaterThanOrEqual(0);
    expect(remoteClient).toBeGreaterThan(acquire);
    expect(remoteWrite).toBeGreaterThan(remoteClient);
    expect(release).toBeGreaterThan(remoteWrite);
  });

  it('keeps retries scoped to the two read-only drift queries and never retries resolution mutations', () => {
    const queryRetryUses = banner.match(/retry: retryDriftContention/g) ?? [];
    const delayUses = banner.match(/retryDelay: nitradoDriftRetryDelay/g) ?? [];

    expect(queryRetryUses).toHaveLength(2);
    expect(delayUses).toHaveLength(2);
    expect(banner).not.toContain('retry: false');
    expect(banner).toContain('const resolve = useMutation({');
    expect(banner).not.toContain('retry: retryDriftContention,\n    mutationFn:');
  });

  it('never presents exhausted binding contention as confirmed drift or as a hard drift failure', () => {
    expect(banner).toContain('if (isTransientNitradoDriftConflict(described)) return null;');
    expect(banner).toContain('const onlyTransientContention = !hasDrift && hasTransientContention && uniqueErrors.length === 0;');
    expect(banner).toContain("? 'Nitrado-Prüfung wird verzögert'");
    expect(banner).toContain('V-Bot hat keine Abweichung bestätigt und prüft den Zustand automatisch erneut.');
    expect(banner).toContain('Dieser Zustand ist kein Drift und wird nicht als Abweichung gewertet.');
    expect(banner).toContain("? 'Manuelle Nitrado-Abweichung erkannt'");
    expect(banner).toContain("'Nitrado-Driftprüfung fehlgeschlagen'");
  });
});
