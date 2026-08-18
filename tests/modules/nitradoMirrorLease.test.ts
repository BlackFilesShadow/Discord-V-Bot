const leaseFindUnique = jest.fn();
const leaseUpdateMany = jest.fn();
const leaseDeleteMany = jest.fn();
const leaseCreate = jest.fn();
const snapshotFindFirst = jest.fn();
const snapshotCreate = jest.fn();
const snapshotUpdateMany = jest.fn();
const transaction = jest.fn();

const tx = {
  nitradoMirrorLease: {
    findUnique: leaseFindUnique,
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
  mirrorLeaseBindingKey,
  NitradoMirrorLeaseLostError,
  refreshMirrorLeaseForCommit,
  releaseMirrorSnapshotLease,
  renewMirrorSnapshotLease,
} from '../../src/modules/nitrado/mirror/mirrorLease';

const GUILD = 'guild-1';
const CONN = 'conn-1';
const BINDING_KEY = 'binding-key-1';
const acquireInput = (overrides: Record<string, unknown> = {}) => ({
  guildId: GUILD,
  nitradoConnId: CONN,
  serviceId: '123',
  bindingKey: BINDING_KEY,
  triggeredBy: 'dev-1',
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  transaction.mockImplementation(async (fn: (client: typeof tx) => unknown) => fn(tx));
  leaseFindUnique.mockResolvedValue(null);
  leaseUpdateMany.mockResolvedValue({ count: 1 });
  leaseDeleteMany.mockResolvedValue({ count: 1 });
  leaseCreate.mockResolvedValue({});
  snapshotFindFirst.mockResolvedValue(null);
  snapshotCreate.mockResolvedValue({ id: 'snap-new' });
  snapshotUpdateMany.mockResolvedValue({ count: 1 });
});

describe('Nitrado-1T persistent mirror singleflight lease', () => {
  it('derives a deterministic non-reversible key from token, service and binding version', () => {
    const first = mirrorLeaseBindingKey({ encryptedToken: 'cipher-a', nitradoServerId: '123', bindingVersion: 4 });
    const same = mirrorLeaseBindingKey({ encryptedToken: 'cipher-a', nitradoServerId: '123', bindingVersion: 4 });
    const tokenChanged = mirrorLeaseBindingKey({ encryptedToken: 'cipher-b', nitradoServerId: '123', bindingVersion: 4 });
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(same).toBe(first);
    expect(tokenChanged).not.toBe(first);
    expect(first).not.toContain('cipher-a');
  });

  it('creates one RUNNING snapshot and a binding-fingerprinted token lease', async () => {
    const result = await acquireMirrorSnapshotLease(acquireInput());
    expect(result).toEqual(expect.objectContaining({ snapshotId: 'snap-new', reused: false }));
    expect(snapshotCreate).toHaveBeenCalledWith({
      data: { guildId: GUILD, nitradoConnId: CONN, serviceId: '123', status: 'RUNNING', triggeredBy: 'dev-1' },
      select: { id: true },
    });
    expect(leaseCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        guildId: GUILD,
        nitradoConnId: CONN,
        snapshotId: 'snap-new',
        leaseToken: expect.any(String),
        bindingKey: BINDING_KEY,
        heartbeatAt: expect.any(Date),
        leaseExpiresAt: expect.any(Date),
      }),
    });
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'Serializable' });
  });

  it('reuses only the same active binding generation', async () => {
    leaseFindUnique.mockResolvedValue({
      snapshotId: 'snap-running', leaseToken: 'lease-running', bindingKey: BINDING_KEY,
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    snapshotFindFirst.mockResolvedValue({ id: 'snap-running', status: 'RUNNING' });

    await expect(acquireMirrorSnapshotLease(acquireInput()))
      .resolves.toEqual({ snapshotId: 'snap-running', leaseToken: null, reused: true });
    expect(snapshotCreate).not.toHaveBeenCalled();
  });

  it.each([
    ['token/service generation changed', { bindingKey: 'old-binding', leaseExpiresAt: new Date(Date.now() + 60_000) }],
    ['lease expired', { bindingKey: BINDING_KEY, leaseExpiresAt: new Date(Date.now() - 60_000) }],
  ])('recovers RUNNING when %s', async (_label, leaseState) => {
    leaseFindUnique.mockResolvedValue({ snapshotId: 'snap-orphan', leaseToken: 'lease-old', ...leaseState });
    snapshotFindFirst.mockResolvedValue({ id: 'snap-orphan', status: 'RUNNING' });

    const result = await acquireMirrorSnapshotLease(acquireInput());
    expect(snapshotUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'snap-orphan', status: 'RUNNING' }),
      data: expect.objectContaining({ status: 'FAILED', finishedAt: expect.any(Date) }),
    }));
    expect(leaseDeleteMany).toHaveBeenCalledWith({
      where: { guildId: GUILD, nitradoConnId: CONN, leaseToken: 'lease-old' },
    });
    expect(result).toEqual(expect.objectContaining({ snapshotId: 'snap-new', reused: false }));
  });

  it('keeps an unexpired terminal snapshot lease active through knowledge finalization', async () => {
    leaseFindUnique.mockResolvedValue({
      snapshotId: 'snap-finalizing', leaseToken: 'lease-finalizing', bindingKey: BINDING_KEY,
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    snapshotFindFirst.mockResolvedValue({ id: 'snap-finalizing', status: 'OK' });
    await expect(acquireMirrorSnapshotLease(acquireInput()))
      .resolves.toEqual({ snapshotId: 'snap-finalizing', leaseToken: null, reused: true });
    expect(snapshotCreate).not.toHaveBeenCalled();
  });

  it('bounded-retries serialization conflicts', async () => {
    transaction
      .mockRejectedValueOnce(Object.assign(new Error('serialization'), { code: 'P2034' }))
      .mockImplementationOnce(async (fn: (client: typeof tx) => unknown) => fn(tx));
    await expect(acquireMirrorSnapshotLease(acquireInput()))
      .resolves.toEqual(expect.objectContaining({ snapshotId: 'snap-new', reused: false }));
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it('renews only an exact unexpired lease and fails closed after token/expiry loss', async () => {
    await expect(renewMirrorSnapshotLease({
      guildId: GUILD, nitradoConnId: CONN, snapshotId: 'snap-1', leaseToken: 'lease-1',
    })).resolves.toBeUndefined();
    expect(leaseUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ leaseToken: 'lease-1', leaseExpiresAt: { gt: expect.any(Date) } }),
    }));
    leaseUpdateMany.mockResolvedValueOnce({ count: 0 });
    await expect(renewMirrorSnapshotLease({
      guildId: GUILD, nitradoConnId: CONN, snapshotId: 'snap-1', leaseToken: 'stale',
    })).rejects.toBeInstanceOf(NitradoMirrorLeaseLostError);
  });

  it('refreshes the supplied transaction row before knowledge commit', async () => {
    await refreshMirrorLeaseForCommit(tx as never, {
      guildId: GUILD, nitradoConnId: CONN, snapshotId: 'snap-1', leaseToken: 'lease-1',
    });
    expect(leaseUpdateMany).toHaveBeenCalledTimes(1);
  });

  it('terminalizes RUNNING with lease CAS while retaining lease until index completion', async () => {
    const result = await finalizeMirrorSnapshotLease({
      guildId: GUILD, nitradoConnId: CONN, snapshotId: 'snap-1', leaseToken: 'lease-1', status: 'OK',
      totalFiles: 2, totalDirs: 1, totalBytes: 10n, storedBytes: 10n, oversizeFiles: 0, errorCount: 0, lastError: null,
    });
    expect(result).toBe(true);
    expect(snapshotUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'snap-1', status: 'RUNNING' }),
      data: expect.objectContaining({ status: 'OK', finishedAt: expect.any(Date) }),
    }));
    expect(leaseDeleteMany).not.toHaveBeenCalled();
  });

  it('does not terminalize after lease recovery and releases only an exact lease token', async () => {
    leaseUpdateMany.mockResolvedValueOnce({ count: 0 });
    await expect(finalizeMirrorSnapshotLease({
      guildId: GUILD, nitradoConnId: CONN, snapshotId: 'snap-1', leaseToken: 'old', status: 'OK',
      totalFiles: 0, totalDirs: 0, totalBytes: 0n, storedBytes: 0n, oversizeFiles: 0, errorCount: 0, lastError: null,
    })).resolves.toBe(false);
    expect(snapshotUpdateMany).not.toHaveBeenCalled();

    leaseDeleteMany.mockResolvedValueOnce({ count: 1 });
    await expect(releaseMirrorSnapshotLease({
      guildId: GUILD, nitradoConnId: CONN, snapshotId: 'snap-1', leaseToken: 'lease-1',
    })).resolves.toBe(true);
    expect(leaseDeleteMany).toHaveBeenLastCalledWith({
      where: { guildId: GUILD, nitradoConnId: CONN, snapshotId: 'snap-1', leaseToken: 'lease-1' },
    });
  });
});
