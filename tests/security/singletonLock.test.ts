process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

/**
 * F-008 Regression: Singleton-Lock nutzt einen atomaren PostgreSQL-Advisory-
 * Lock. Kann er nicht erworben werden (andere aktive Instanz), beendet sich
 * die Instanz (process.exit(2)) — kein Split-Brain.
 */
jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { advisoryLockKeys, acquireSingletonLock } from '../../src/utils/singleton';
import type { Client } from 'pg';

function fakeClient(locked: boolean): { client: Client; query: jest.Mock } {
  const query = jest.fn(async (sql: string) => {
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked }] };
    return { rows: [] };
  });
  const client = {
    connect: jest.fn(async () => undefined),
    query,
    on: jest.fn(),
    end: jest.fn(async () => undefined),
  } as unknown as Client;
  return { client, query };
}

describe('F-008 — Singleton Advisory-Lock', () => {
  let exitSpy: jest.SpyInstance;
  beforeEach(() => {
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  });
  afterEach(() => { exitSpy.mockRestore(); jest.clearAllMocks(); });

  it('erzeugt deterministische (int4,int4)-Keys', () => {
    const a = advisoryLockKeys('bot:singleton:lock:solo');
    const b = advisoryLockKeys('bot:singleton:lock:solo');
    const c = advisoryLockKeys('bot:singleton:lock:1');
    expect(a).toEqual(b);
    expect(a[0]).toBe(0x56424f54);
    expect(a).not.toEqual(c);
    expect(Number.isInteger(a[1])).toBe(true);
  });

  it('erwirbt den Lock, wenn pg_try_advisory_lock true liefert', async () => {
    const { client, query } = fakeClient(true);
    await acquireSingletonLock(() => client);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('pg_try_advisory_lock'),
      expect.arrayContaining([0x56424f54]),
    );
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('beendet die Instanz, wenn der Lock bereits gehalten wird', async () => {
    const { client } = fakeClient(false);
    await acquireSingletonLock(() => client);
    expect(exitSpy).toHaveBeenCalledWith(2);
  });
});
