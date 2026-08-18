const pgConnect = jest.fn();
const pgQuery = jest.fn();
const pgEnd = jest.fn();

jest.mock('pg', () => ({
  Client: jest.fn().mockImplementation(() => ({
    connect: pgConnect,
    query: pgQuery,
    end: pgEnd,
  })),
}));

jest.mock('../../src/utils/logger', () => ({
  logger: { warn: jest.fn() },
}));

import {
  nitradoConfigMutationLockKeys,
  tryAcquireNitradoConfigMutationLock,
} from '../../src/modules/nitrado/configMutationLock';

beforeEach(() => {
  jest.clearAllMocks();
  pgConnect.mockResolvedValue(undefined);
  pgEnd.mockResolvedValue(undefined);
});

describe('Nitrado-1C config mutation connection lock', () => {
  it('derives deterministic per-connection lock keys in the NITR namespace', () => {
    const a = nitradoConfigMutationLockKeys('conn-1');
    const b = nitradoConfigMutationLockKeys('conn-1');
    const c = nitradoConfigMutationLockKeys('conn-2');

    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect(a[0]).toBe(0x4e495452);
    expect(Number.isInteger(a[1])).toBe(true);
  });

  it('returns null and closes the pg session when the worker already owns the lock', async () => {
    pgQuery.mockResolvedValueOnce({ rows: [{ locked: false }] });

    await expect(tryAcquireNitradoConfigMutationLock('conn-1')).resolves.toBeNull();

    expect(pgQuery).toHaveBeenCalledWith(
      'SELECT pg_try_advisory_lock($1, $2) AS locked',
      nitradoConfigMutationLockKeys('conn-1'),
    );
    expect(pgEnd).toHaveBeenCalledTimes(1);
  });

  it('holds and releases the exact same session lock idempotently', async () => {
    pgQuery
      .mockResolvedValueOnce({ rows: [{ locked: true }] })
      .mockResolvedValueOnce({ rows: [{ pg_advisory_unlock: true }] });

    const lock = await tryAcquireNitradoConfigMutationLock('conn-1');
    expect(lock).not.toBeNull();

    await lock!.release();
    await lock!.release();

    expect(pgQuery).toHaveBeenLastCalledWith(
      'SELECT pg_advisory_unlock($1, $2)',
      nitradoConfigMutationLockKeys('conn-1'),
    );
    expect(pgEnd).toHaveBeenCalledTimes(1);
  });
});
