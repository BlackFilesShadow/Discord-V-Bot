process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';

const jobUpdateMany = jest.fn();
const jobFindMany = jest.fn();
const leaseCreate = jest.fn();
const leaseDeleteMany = jest.fn();
const leaseUpdateMany = jest.fn();
const leaseFindMany = jest.fn();
const leaseFindUnique = jest.fn();

const tx = {
  nitradoJob: { updateMany: jobUpdateMany },
  nitradoJobLease: { create: leaseCreate, deleteMany: leaseDeleteMany },
};

const transaction = jest.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx));
const prismaMock = {
  $transaction: transaction,
  nitradoJob: { updateMany: jobUpdateMany, findMany: jobFindMany },
  nitradoJobLease: {
    create: leaseCreate,
    deleteMany: leaseDeleteMany,
    updateMany: leaseUpdateMany,
    findMany: leaseFindMany,
    findUnique: leaseFindUnique,
  },
};

jest.mock('../../src/database/prisma', () => ({ __esModule: true, default: prismaMock }));

import {
  claimNitradoJob,
  heartbeatNitradoJobClaim,
  recoverStaleNitradoJobClaims,
  transitionClaimedNitradoJob,
  type NitradoJobClaim,
} from '../../src/modules/nitrado/jobLease';

const NOW = new Date('2026-08-18T15:30:00.000Z');
const CLAIM: NitradoJobClaim = { id: 'job-1', guildId: 'guild-1', claimToken: 'claim-current' };

beforeEach(() => {
  jest.clearAllMocks();
  transaction.mockImplementation(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx));
  jobUpdateMany.mockResolvedValue({ count: 1 });
  jobFindMany.mockResolvedValue([]);
  leaseCreate.mockResolvedValue({});
  leaseDeleteMany.mockResolvedValue({ count: 1 });
  leaseUpdateMany.mockResolvedValue({ count: 1 });
  leaseFindMany.mockResolvedValue([]);
  leaseFindUnique.mockResolvedValue(null);
});

describe('Nitrado-1I durable job lease', () => {
  it('claims PENDING -> RUNNING and creates the lease in one transaction', async () => {
    const claim = await claimNitradoJob({ id: 'job-1', guildId: 'guild-1', now: NOW });

    expect(claim).not.toBeNull();
    expect(jobUpdateMany).toHaveBeenCalledWith({
      where: { id: 'job-1', guildId: 'guild-1', status: 'PENDING' },
      data: { status: 'RUNNING', updatedAt: NOW },
    });
    expect(leaseDeleteMany).toHaveBeenCalledWith({ where: { jobId: 'job-1' } });
    expect(leaseCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        jobId: 'job-1',
        guildId: 'guild-1',
        claimToken: expect.any(String),
        claimedAt: NOW,
        heartbeatAt: NOW,
      }),
    });
  });

  it('does not create a lease if the PENDING claim CAS loses the race', async () => {
    jobUpdateMany.mockResolvedValueOnce({ count: 0 });

    await expect(claimNitradoJob({ id: 'job-1', guildId: 'guild-1', now: NOW })).resolves.toBeNull();
    expect(leaseCreate).not.toHaveBeenCalled();
  });

  it('heartbeats only the exact current claim token', async () => {
    await expect(heartbeatNitradoJobClaim(CLAIM, NOW)).resolves.toBe(true);
    expect(leaseUpdateMany).toHaveBeenCalledWith({
      where: { jobId: 'job-1', guildId: 'guild-1', claimToken: 'claim-current' },
      data: { heartbeatAt: NOW },
    });
  });

  it('fences an old owner before it can transition a newer claim', async () => {
    leaseDeleteMany.mockResolvedValueOnce({ count: 0 });

    await expect(transitionClaimedNitradoJob(CLAIM, { status: 'DONE', lastError: null, updatedAt: NOW })).resolves.toBe(false);
    expect(jobUpdateMany).not.toHaveBeenCalled();
  });

  it('removes the owned lease and transitions RUNNING in the same transaction', async () => {
    await expect(transitionClaimedNitradoJob(CLAIM, { status: 'PENDING', nextRunAt: NOW, updatedAt: NOW })).resolves.toBe(true);

    expect(leaseDeleteMany).toHaveBeenCalledWith({
      where: { jobId: 'job-1', guildId: 'guild-1', claimToken: 'claim-current' },
    });
    expect(jobUpdateMany).toHaveBeenCalledWith({
      where: { id: 'job-1', guildId: 'guild-1', status: 'RUNNING' },
      data: { status: 'PENDING', nextRunAt: NOW, updatedAt: NOW },
    });
  });

  it('recovers only a still-stale durable lease and requeues its RUNNING job', async () => {
    leaseFindMany.mockResolvedValueOnce([
      { jobId: 'job-1', guildId: 'guild-1', claimToken: 'claim-old' },
    ]);
    jobFindMany.mockResolvedValueOnce([]);

    await expect(recoverStaleNitradoJobClaims(NOW, 60_000)).resolves.toBe(1);
    expect(leaseDeleteMany).toHaveBeenCalledWith({
      where: {
        jobId: 'job-1',
        guildId: 'guild-1',
        claimToken: 'claim-old',
        heartbeatAt: { lt: new Date(NOW.getTime() - 60_000) },
      },
    });
    expect(jobUpdateMany).toHaveBeenCalledWith({
      where: { id: 'job-1', guildId: 'guild-1', status: 'RUNNING' },
      data: { status: 'PENDING', updatedAt: NOW },
    });
  });

  it('keeps a lease when its heartbeat changed after the stale scan', async () => {
    leaseFindMany.mockResolvedValueOnce([
      { jobId: 'job-1', guildId: 'guild-1', claimToken: 'claim-old' },
    ]);
    leaseDeleteMany.mockResolvedValueOnce({ count: 0 });
    jobFindMany.mockResolvedValueOnce([]);

    await expect(recoverStaleNitradoJobClaims(NOW, 60_000)).resolves.toBe(0);
    expect(jobUpdateMany).not.toHaveBeenCalled();
  });

  it('recovers a stale legacy RUNNING job only when no durable lease exists', async () => {
    leaseFindMany.mockResolvedValueOnce([]);
    jobFindMany.mockResolvedValueOnce([{ id: 'legacy-job', guildId: 'guild-1' }]);
    leaseFindUnique.mockResolvedValueOnce(null);

    await expect(recoverStaleNitradoJobClaims(NOW, 60_000)).resolves.toBe(1);
    expect(jobUpdateMany).toHaveBeenCalledWith({
      where: {
        id: 'legacy-job',
        guildId: 'guild-1',
        status: 'RUNNING',
        updatedAt: { lt: new Date(NOW.getTime() - 60_000) },
      },
      data: { status: 'PENDING', updatedAt: NOW },
    });
  });
});
