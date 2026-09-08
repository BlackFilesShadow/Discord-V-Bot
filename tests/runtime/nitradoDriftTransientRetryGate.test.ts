import fs from 'node:fs';
import path from 'node:path';
import {
  isTransientNitradoDriftConflict,
  NITRADO_DRIFT_RETRY_DELAYS_MS,
  nitradoDriftRetryDelay,
  shouldRetryNitradoDrift,
} from '../../dashboard-ui/src/lib/nitradoDriftRetry';
import { normalizeSourceNewlines } from '../helpers/sourceText';

const read = (relative: string): string => normalizeSourceNewlines(
  fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8'),
);

const busy = {
  status: 409,
  code: null,
  desc: 'Nitrado-Verbindung wird gerade sicher verarbeitet oder parallel geaendert. Bitte erneut laden.',
};

const staleRead = {
  status: 409,
  code: null,
  desc: 'Nitrado-Zuordnung hat sich waehrend der Drift-Pruefung geaendert. Bitte erneut laden.',
};

const staleConfirm = {
  status: 409,
  code: null,
  desc: 'Nitrado-Zuordnung hat sich waehrend der Drift-Bestaetigung geaendert. Bitte erneut laden.',
};

describe('Nitrado drift transient contention retry gate', () => {
  it('recognizes every currently deployed binding-fence 409 as transient contention', () => {
    expect(isTransientNitradoDriftConflict(busy)).toBe(true);
    expect(isTransientNitradoDriftConflict(staleRead)).toBe(true);
    expect(isTransientNitradoDriftConflict(staleConfirm)).toBe(true);
  });

  it('accepts machine-readable binding codes without broadening all HTTP 409 conflicts', () => {
    expect(isTransientNitradoDriftConflict({
      status: 409,
      code: 'NITRADO_BINDING_BUSY',
      desc: 'future localized copy',
    })).toBe(true);
    expect(isTransientNitradoDriftConflict({
      status: 409,
      code: 'NITRADO_BINDING_STALE',
      desc: 'future localized copy',
    })).toBe(true);
    expect(isTransientNitradoDriftConflict({
      status: 409,
      code: null,
      desc: 'Nitrado-Verbindung ist nicht ACTIVE oder besitzt keine Service-ID.',
    })).toBe(false);
    expect(isTransientNitradoDriftConflict({
      status: 409,
      code: 'OTHER_CONFLICT',
      desc: 'Nitrado-Slot wurde parallel geaendert.',
    })).toBe(false);
    expect(isTransientNitradoDriftConflict({
      status: 502,
      code: 'NITRADO_BINDING_BUSY',
      desc: busy.desc,
    })).toBe(false);
  });

  it('uses a bounded backoff long enough to outlive normal remote-worker lock ownership', () => {
    expect(NITRADO_DRIFT_RETRY_DELAYS_MS).toEqual([500, 1_500, 3_000, 6_000, 10_000]);
    expect(NITRADO_DRIFT_RETRY_DELAYS_MS.reduce((sum, value) => sum + value, 0)).toBe(21_000);

    for (let failureCount = 0; failureCount < NITRADO_DRIFT_RETRY_DELAYS_MS.length; failureCount += 1) {
      expect(shouldRetryNitradoDrift(failureCount, busy)).toBe(true);
    }
    expect(shouldRetryNitradoDrift(NITRADO_DRIFT_RETRY_DELAYS_MS.length, busy)).toBe(false);
    expect(shouldRetryNitradoDrift(0, { ...busy, status: 500 })).toBe(false);

    expect(nitradoDriftRetryDelay(-1)).toBe(500);
    expect(nitradoDriftRetryDelay(0)).toBe(500);
    expect(nitradoDriftRetryDelay(1)).toBe(1_500);
    expect(nitradoDriftRetryDelay(4)).toBe(10_000);
    expect(nitradoDriftRetryDelay(99)).toBe(10_000);
  });

  it('keeps the UI retry scoped to read-only drift queries and softens exhausted contention', () => {
    const banner = read('dashboard-ui/src/components/NitradoDriftBanner.tsx');
    const queryRetryUses = banner.match(/retry: retryDriftContention/g) ?? [];
    const delayUses = banner.match(/retryDelay: nitradoDriftRetryDelay/g) ?? [];

    expect(queryRetryUses).toHaveLength(2);
    expect(delayUses).toHaveLength(2);
    expect(banner).not.toContain('retry: false');
    expect(banner).toContain('if (isTransientNitradoDriftConflict(described)) return null;');
    expect(banner).toContain("? 'Nitrado-Prüfung wird verzögert'");
    expect(banner).toContain('V-Bot hat keine Abweichung bestätigt und prüft den Zustand automatisch erneut.');
    expect(banner).toContain('Dieser Zustand ist kein Drift und wird nicht als Abweichung gewertet.');
    expect(banner).toContain('const resolve = useMutation({');
    expect(banner).not.toContain('retry: retryDriftContention,\n    mutationFn:');
  });

  it('pins the compatibility fallback to the exact backend binding-fence messages', () => {
    const route = read('src/dashboard/routes/v2/nitradoDrift.ts');
    const retry = read('dashboard-ui/src/lib/nitradoDriftRetry.ts');
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
});
