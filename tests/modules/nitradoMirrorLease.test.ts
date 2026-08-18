const leaseFindUnique = jest.fn();
const leaseUpdateMany = jest.fn();
const leaseDeleteMany = jest.fn();
const leaseCreate = jest.fn();
const leaseFindFirst = jest.fn();
const snapshotFindFirst = jest.fn();
const snapshotCreate = jest.fn();
const snapshotUpdateMany = jest.fn();
const transaction = jest.fn();

const tx = {
  nitradoMirrorLease: {
    findUnique: leaseFindUnique,
    findFirst: leaseFindFirst,
    updateMany: leaseUpdateMany,
    deleteMany: leaseDeleteMany,
    create: leaseCreate,
  },
  nitradoSnapshot: {
    findFirst: snapshotFindFirst,
    create: snapshotCreate,
    updateMany: snapshotUpdateMany,
  },
};

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    nitradoMirrorLease: {
      updateMany: (...args: unknown[]) => leaseUpdateMany(...args),
      deleteMany: (...args: unknown[]) => leaseDeleteMany(...args),
    },
    $transaction: (...args: unknown[]) => transaction(...args),
  },
}));

import {
  acquireMirrorSnapshotLease,
  finalizeMirrorSnapshotLease,
  NitradoMirrorLeaseLostError,
  refreshMirrorLeaseForCommit,
  releaseMirrorSnapshotLease,
  renewMirrorSnapshotLease,
} from '../../src/modules/nitrado/mirror/mirrorLease';

const GUILD = 'guild-1';
const CONN = 'conn-1';

beforeEach(() => {
  jest.clearAllMocks();
  transaction.mockImplementation(async (fn: (client: typeof tx) => unknown) => fn(tx));
  leaseFindUnique.mockResolvedValue(null);
  leaseFindFirst.mockResolvedValue({ leaseToken: 'lease-1' });
  leaseUpdateMany.mockResolvedValue({ count: 1 });
  leaseDeleteMany.mockResolvedValue({ count: 1 });
  leaseCreate.mockResolvedValue({});
  snapshotFindFirst.mockResolvedValue(null);
  snapshotCreate.mockResolvedValue({ id: 'snap-new' });
  snapshotUpdateMany.mockResolvedValue({ count: 1 });
});

describe('Nitrado-1T persistent mirror singleflight lease', () => {
  it('creates one RUNNING snapshot and one token-fenced lease when no lease exists', async () => {
    const result = await acquireMirrorSnapshotLease({
      guildId: GUILD,
      nitradoConnId: CONN,
      serviceId: '123',
      triggeredBy: 'dev-1',
    });

    expect(result).toEqual(expect.objectContaining({ snapshotId: 'snap-new', reused: false }));
    expect(typeof result.leaseToken).toBe('string');
    expect(snapshotCreate).toHaveBeenCalledWith({
      data: {
        guildId: GUILD,
        nitradoConnId: CONN,
        serviceId: '123',
        status: 'RUNNING',
        triggeredBy: 'dev-1',
      },
      select: { id: true },
    });
    expect(leaseCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        guildId: GUILD,
        nitradoConnId: CONN,
        snapshotId: 'snap-new',
        leaseToken: expect.any(String),
        heartbeatAt: expect.any(Date),
        leaseExpiresAt: expect.any(Date),
      }),
    });
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'Serializable' });
  });

  it('returns the existing snapshot and does not start a duplicate while its lease is active', async () => {
    leaseFindUnique.mockResolvedValue({
      snapshotId: 'snap-running',
      leaseToken: 'lease-running',
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    snapshotFindFirst.mockResolvedValue({ id: 'snap-running', status: 'RUNNING' });

    const result = await acquireMirrorSnapshotLease({
      guildId: GUILD, nitradoConnId: CONN, serviceId: '123', triggeredBy: 'dev-2',
    });

    expect(result).toEqual({ snapshotId: 'snap-running', leaseToken: null, reused: true });
    expect(snapshotCreate).not.toHaveBeenCalled();
    expect(leaseCreate).not.toHaveBeenCalled();
    expect(leaseDeleteMany).not.toHaveBeenCalled();
  });

  it('keeps an unexpired lease singleflight-active during terminal knowledge finalization', async () => {
    leaseFindUnique.mockResolvedValue({
      snapshotId: 'snap-finalizing',
      leaseToken: 'lease-finalizing',
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    snapshotFindFirst.mockResolvedValue({ id: 'snap-finalizing', status: 'OK' });

    const result = await acquireMirrorSnapshotLease({
      guildId: GUILD, nitradoConnId: CONN, serviceId: '123', triggeredBy: 'dev-2',
    });

    expect(result).toEqual({ snapshotId: 'snap-finalizing', leaseToken: null, reused: true });
    expect(snapshotCreate).not.toHaveBeenCalled();
  });

  it('recovers an expired RUNNING lease by failing the orphan before creating the replacement', async () => {
    leaseFindUnique.mockResolvedValue({
      snapshotId: 'snap-orphan',
      leaseToken: 'lease-old',
      leaseExpiresAt: new Date(Date.now() - 60_000),
    });
    snapshotFindFirst.mockResolvedValue({ id: 'snap-orphan', status: 'RUNNING' });

    const result = await acquireMirrorSnapshotLease({
      guildId: GUILD, nitradoConnId: CONN, serviceId: '123', triggeredBy: 'dev-3',
    });

    expect(snapshotUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'snap-orphan', status: 'RUNNING' }),
      data: expect.objectContaining({ status: 'FAILED', finishedAt: expect.any(Date) }),
    }));
    expect(leaseDeleteMany).toHaveBeenCalledWith({
      where: { guildId: GUILD, nitradoConnId: CONN, leaseToken: 'lease-old' },
    });
    expect(result).toEqual(expect.objectContaining({ snapshotId: 'snap-new', reused: false }));
    expect(snapshotUpdateMany.mock.invocationCallOrder[0]).toBeLessThan(snapshotCreate.mock.invocationCallOrder[0]);
  });

  it('bounded-retries a serialization conflict before establishing the lease', async () => {
    transaction
      .mockRejectedValueOnce(Object.assign(new Error('serialization'), { code: 'P2034' }))
      .mockImplementationOnce(async (fn: (client: typeof tx) => unknown) => fn(tx));

    await expect(acquireMirrorSnapshotLease({
      guildId: GUILD, nitradoConnId: CONN, serviceId: '123', triggeredBy: 'dev-4',
    })).resolves.toEqual(expect.objectContaining({ snapshotId: 'snap-new', reused: false }));

    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it('renews only an exact unexpired lease and fails closed after token/expiry loss', async () => {
    await expect(renewMirrorSnapshotLease({
      guildId: GUILD, nitradoConnId: CONN, snapshotId: 'snap-1', leaseToken: 'lease-1',
    })).resolves.toBeUndefined();
    expect(leaseUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        guildId: GUILD, nitradoConnId: CONN, snapshotId: 'snap-1', leaseToken: 'lease-1',
        leaseExpiresAt: { gt: expect.any(Date) },
      }),
    }));

    leaseUpdateMany.mockResolvedValueOnce({ count: 0 });
    await expect(renewMirrorSnapshotLease({
      guildId: GUILD, nitradoConnId: CONN, snapshotId: 'snap-1', leaseToken: 'stale',
    })).rejects.toBeInstanceOf(NitradoMirrorLeaseLostError);
  });

  it('refreshes the lease on the supplied transaction client before a knowledge commit', async () => {
    await refreshMirrorLeaseForCommit(tx as never, {
      guildId: GUILD, nitradoConnId: CONN, snapshotId: 'snap-1', leaseToken: 'lease-1',
    });
    expect(leaseUpdateMany).toHaveBeenCalledTimes(1);
  });

  it('terminalizes RUNNING with lease CAS but deliberately retains lease until index completion', async () => {
    const result = await finalizeMirrorSnapshotLease({
      guildId: GUILD,
      nitradoConnId: CONN,
      snapshotId: 'snap-1',
      leaseToken: 'lease-1',
      status: 'OK',
      totalFiles: 2,
      totalDirs: 1,
      totalBytes: 10n,
      storedBytes: 10n,
      oversizeFiles: 0,
      errorCount: 0,
      lastError: null,
    });

    expect(result).toBe(true);
    expect(leaseUpdateMany).toHaveBeenCalled();
    expect(snapshotUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'snap-1', status: 'RUNNING' }),
      data: expect.objectContaining({ status: 'OK', finishedAt: expect.any(Date) }),
    }));
    expect(leaseDeleteMany).not.toHaveBeenCalled();
  });

  it('does not terminalize when the lease was already recovered', async () => {
    leaseUpdateMany.mockResolvedValueOnce({ count: 0 });

    await expect(finalizeMirrorSnapshotLease({
      guildId: GUILD, nitradoConnId: CONN, snapshotId: 'snap-1', leaseToken: 'old',
      status: 'OK', totalFiles: 0, totalDirs: 0, totalBytes: 0n, storedBytes: 0n,
      oversizeFiles: 0, errorCount: 0, lastError: null,
    })).resolves.toBe(false);

    expect(snapshotUpdateMany).not.toHaveBeenCalled();
  });

  it('releases only the exact token-bound lease after ordered finalization', async () => {
    await expect(releaseMirrorSnapshotLease({
      guildId: GUILD, nitradoConnId: CONN, snapshotId: 'snap-1', leaseToken: 'lease-1',
    })).resolves.toBe(true);
    expect(leaseDeleteMany).toHaveBeenCalledWith({
      where: { guildId: GUILD, nitradoConnId: CONN, snapshotId: 'snap-1', leaseToken: 'lease-1' },
    });
  });
});
