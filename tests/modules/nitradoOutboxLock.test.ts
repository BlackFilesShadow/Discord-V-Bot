import {
  nitradoOutboxLockKeys,
  withNitradoOutboxSubjectLock,
  type NitradoOutboxClient,
  type NitradoOutboxTxClient,
} from '../../src/modules/nitrado/outboxLock';

describe('Nitrado-1A outbox subject lock', () => {
  it('hashes sensitive subject text to deterministic int32 lock keys', () => {
    const a = nitradoOutboxLockKeys('guild:conn:WHITELIST_ADD:Player One');
    const b = nitradoOutboxLockKeys('guild:conn:WHITELIST_ADD:Player One');
    const c = nitradoOutboxLockKeys('guild:conn:WHITELIST_ADD:Player Two');

    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect(a).toHaveLength(2);
    expect(a.every(Number.isInteger)).toBe(true);
  });

  it('uses an existing transaction client without opening a nested transaction', async () => {
    const queryRaw = jest.fn(async () => []);
    const tx = {
      $queryRawUnsafe: queryRaw,
      nitradoJob: { findMany: jest.fn(), create: jest.fn() },
    } as unknown as NitradoOutboxTxClient;
    const work = jest.fn(async () => 'ok');

    await expect(withNitradoOutboxSubjectLock(tx, 'secret-subject', work)).resolves.toBe('ok');

    expect(queryRaw).toHaveBeenCalledWith(
      'SELECT pg_advisory_xact_lock($1, $2)',
      expect.any(Number),
      expect.any(Number),
    );
    expect(work).toHaveBeenCalledWith(tx);
  });

  it('opens a transaction for a Prisma-root-style client so the xact lock survives until commit', async () => {
    const queryRaw = jest.fn(async () => []);
    const tx = {
      $queryRawUnsafe: queryRaw,
      nitradoJob: { findMany: jest.fn(), create: jest.fn() },
    } as unknown as NitradoOutboxTxClient;
    const transaction = jest.fn(async (cb: (arg: NitradoOutboxTxClient) => Promise<unknown>) => cb(tx));
    const root = {
      $queryRawUnsafe: jest.fn(),
      $transaction: transaction,
      nitradoJob: { findMany: jest.fn(), create: jest.fn() },
    } as unknown as NitradoOutboxClient;

    await withNitradoOutboxSubjectLock(root, 'subject', async lockedTx => {
      expect(lockedTx).toBe(tx);
      return true;
    });

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect((root as { $queryRawUnsafe: jest.Mock }).$queryRawUnsafe).not.toHaveBeenCalled();
  });
});
