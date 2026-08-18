const jobFindUnique = jest.fn();
const jobUpdateMany = jest.fn();
const connectionFindFirst = jest.fn();
const reconcileIntent = jest.fn();
const decrypt = jest.fn();
const addToWhitelist = jest.fn();
const removeFromWhitelist = jest.fn();
const audit = jest.fn();
const emit = jest.fn();
const pgQuery = jest.fn();
const pgConnect = jest.fn();
const pgEnd = jest.fn();

type TestClaim = { id: string; guildId: string; claimToken: string };
const mockHeartbeatClaim = jest.fn(async (_claim: TestClaim) => true);
const mockTransitionClaim = jest.fn(async (claim: TestClaim, data: Record<string, unknown>) => {
  await jobUpdateMany({
    where: { id: claim.id, guildId: claim.guildId, status: 'RUNNING' },
    data,
  });
  return true;
});

jest.mock('pg', () => ({
  Client: jest.fn().mockImplementation(() => ({
    connect: pgConnect,
    query: pgQuery,
    end: pgEnd,
  })),
}));

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    nitradoJob: {
      findUnique: jobFindUnique,
      updateMany: jobUpdateMany,
      findMany: jest.fn(),
    },
    nitradoConnection: { findFirst: connectionFindFirst },
    serverBanEntry: { findFirst: jest.fn(), updateMany: jest.fn(), findMany: jest.fn() },
  },
}));

jest.mock('../../src/config', () => ({
  config: { security: { encryptionKey: '0'.repeat(64) } },
}));

jest.mock('../../src/utils/security', () => ({ decrypt }));

jest.mock('../../src/modules/nitrado/nitradoClient', () => ({
  NitradoClient: jest.fn().mockImplementation(() => ({
    addToWhitelist,
    removeFromWhitelist,
  })),
  NitradoApiError: class NitradoApiError extends Error {
    status: number;
    constructor(message: string, status: number) { super(message); this.status = status; }
  },
}));

jest.mock('../../src/modules/nitrado/whitelistIntent', () => ({
  reconcileWhitelistRemoteIntent: reconcileIntent,
}));

jest.mock('../../src/modules/nitrado/jobLease', () => ({
  NITRADO_JOB_HEARTBEAT_INTERVAL_MS: 60_000,
  claimNitradoJob: jest.fn(),
  heartbeatNitradoJobClaim: mockHeartbeatClaim,
  recoverStaleNitradoJobClaims: jest.fn(async () => 0),
  transitionClaimedNitradoJob: mockTransitionClaim,
}));

jest.mock('../../src/modules/bans/banRegistry', () => ({ isBanActive: jest.fn() }));
jest.mock('../../src/modules/bans/banTarget', () => ({ matchesBanIdentifier: jest.fn() }));
jest.mock('../../src/modules/bans/banOutbox', () => ({
  enqueueServerBanAdd: jest.fn(),
  enqueueServerBanRemove: jest.fn(),
  parseServerBanJobPayload: jest.fn(),
}));

jest.mock('../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: audit,
}));

jest.mock('../../src/dashboard/socket/emitter', () => ({ emitGuildEvent: emit }));

import { executeJob } from '../../src/modules/nitrado/jobWorker';

const GUILD = '123456789012345678';
const CONN = 'c123456789012345678901234';

function claim(id: string): TestClaim {
  return { id, guildId: GUILD, claimToken: `claim:${id}` };
}

function job(operation: 'WHITELIST_ADD' | 'WHITELIST_REMOVE', gameId: unknown = 'PlayerOne') {
  return {
    id: `job-${operation}`,
    guildId: GUILD,
    nitradoConnId: CONN,
    operation,
    payload: { gameId },
    attempts: 1,
    maxAttempts: 8,
    status: 'RUNNING',
  };
}

const currentAdd = {
  execute: true,
  desiredState: 'PRESENT',
  reason: 'CURRENT_INTENT',
  compensationQueued: false,
};
const currentRemove = {
  execute: true,
  desiredState: 'UNTRACKED',
  reason: 'CURRENT_INTENT',
  compensationQueued: false,
};

beforeEach(() => {
  jest.clearAllMocks();
  pgConnect.mockResolvedValue(undefined);
  pgEnd.mockResolvedValue(undefined);
  pgQuery
    .mockResolvedValueOnce({ rows: [{ locked: true }] })
    .mockResolvedValue({ rows: [] });
  jobUpdateMany.mockResolvedValue({ count: 1 });
  connectionFindFirst.mockResolvedValue({
    id: CONN,
    guildId: GUILD,
    encryptedToken: 'cipher',
    nitradoServerId: 'service-1',
    status: 'ACTIVE',
    keepOnlineEnabled: false,
  });
  decrypt.mockReturnValue('plain-token');
  addToWhitelist.mockResolvedValue(undefined);
  removeFromWhitelist.mockResolvedValue(undefined);
});

describe('Nitrado-1B worker whitelist intent reconciliation', () => {
  it('turns an old ADD retry into DONE only after a newer remove compensation is guaranteed', async () => {
    jobFindUnique.mockResolvedValue(job('WHITELIST_ADD'));
    reconcileIntent.mockResolvedValue({
      execute: false,
      desiredState: 'PENDING_REMOVE',
      reason: 'SUPERSEDED_BY_REMOVE',
      compensationQueued: true,
    });

    await executeJob(claim('job-WHITELIST_ADD'));

    expect(reconcileIntent).toHaveBeenCalledWith('WHITELIST_ADD', GUILD, CONN, 'PlayerOne');
    expect(reconcileIntent).toHaveBeenCalledTimes(1);
    expect(decrypt).not.toHaveBeenCalled();
    expect(addToWhitelist).not.toHaveBeenCalled();
    expect(removeFromWhitelist).not.toHaveBeenCalled();
    expect(jobUpdateMany).toHaveBeenCalledWith({
      where: { id: 'job-WHITELIST_ADD', guildId: GUILD, status: 'RUNNING' },
      data: { status: 'DONE', lastError: null, updatedAt: expect.any(Date) },
    });
    expect(audit).toHaveBeenCalledWith('NITRADO_WHITELIST_JOB_SUPERSEDED', 'NITRADO', expect.objectContaining({
      guildId: GUILD,
      operation: 'WHITELIST_ADD',
      desiredState: 'PENDING_REMOVE',
      reason: 'SUPERSEDED_BY_REMOVE',
    }));
  });

  it('turns an old REMOVE retry into DONE only after a newer ADD compensation is guaranteed', async () => {
    jobFindUnique.mockResolvedValue(job('WHITELIST_REMOVE'));
    reconcileIntent.mockResolvedValue({
      execute: false,
      desiredState: 'PRESENT',
      reason: 'SUPERSEDED_BY_PRESENT',
      compensationQueued: true,
    });

    await executeJob(claim('job-WHITELIST_REMOVE'));

    expect(decrypt).not.toHaveBeenCalled();
    expect(removeFromWhitelist).not.toHaveBeenCalled();
    expect(reconcileIntent).toHaveBeenCalledTimes(1);
    expect(jobUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'job-WHITELIST_REMOVE', guildId: GUILD, status: 'RUNNING' },
      data: expect.objectContaining({ status: 'DONE' }),
    }));
  });

  it('executes current ADD and rechecks intent after the remote write before DONE', async () => {
    jobFindUnique.mockResolvedValue(job('WHITELIST_ADD'));
    reconcileIntent.mockResolvedValue(currentAdd);

    await executeJob(claim('job-WHITELIST_ADD'));

    expect(decrypt).toHaveBeenCalledWith('cipher', '0'.repeat(64));
    expect(addToWhitelist).toHaveBeenCalledWith('service-1', 'PlayerOne');
    expect(reconcileIntent).toHaveBeenCalledTimes(2);
    expect(jobUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'job-WHITELIST_ADD', guildId: GUILD, status: 'RUNNING' },
      data: expect.objectContaining({ status: 'DONE', lastError: null }),
    }));
  });

  it('keeps remote-only REMOVE executable and rechecks it after the remote write', async () => {
    jobFindUnique.mockResolvedValue(job('WHITELIST_REMOVE', 'RemoteOnly'));
    reconcileIntent.mockResolvedValue(currentRemove);

    await executeJob(claim('job-WHITELIST_REMOVE'));

    expect(removeFromWhitelist).toHaveBeenCalledWith('service-1', 'RemoteOnly');
    expect(reconcileIntent).toHaveBeenCalledTimes(2);
  });

  it('queues REMOVE compensation if local intent flips during an ADD HTTP call', async () => {
    jobFindUnique.mockResolvedValue(job('WHITELIST_ADD'));
    reconcileIntent
      .mockResolvedValueOnce(currentAdd)
      .mockResolvedValueOnce({
        execute: false,
        desiredState: 'PENDING_REMOVE',
        reason: 'SUPERSEDED_BY_REMOVE',
        compensationQueued: true,
      });

    await executeJob(claim('job-WHITELIST_ADD'));

    expect(addToWhitelist).toHaveBeenCalledWith('service-1', 'PlayerOne');
    expect(reconcileIntent).toHaveBeenCalledTimes(2);
    expect(jobUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'DONE' }),
    }));
  });

  it('queues ADD compensation if local intent flips during a REMOVE HTTP call', async () => {
    jobFindUnique.mockResolvedValue(job('WHITELIST_REMOVE'));
    reconcileIntent
      .mockResolvedValueOnce({
        execute: true,
        desiredState: 'PENDING_REMOVE',
        reason: 'CURRENT_INTENT',
        compensationQueued: false,
      })
      .mockResolvedValueOnce({
        execute: false,
        desiredState: 'PRESENT',
        reason: 'SUPERSEDED_BY_PRESENT',
        compensationQueued: true,
      });

    await executeJob(claim('job-WHITELIST_REMOVE'));

    expect(removeFromWhitelist).toHaveBeenCalledWith('service-1', 'PlayerOne');
    expect(reconcileIntent).toHaveBeenCalledTimes(2);
    expect(jobUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'DONE' }),
    }));
  });

  it('treats a pre-write intent reconciliation failure as retryable and performs no token/API work', async () => {
    jobFindUnique.mockResolvedValue(job('WHITELIST_ADD'));
    reconcileIntent.mockRejectedValue(new Error('db temporarily unavailable'));

    await executeJob(claim('job-WHITELIST_ADD'));

    expect(decrypt).not.toHaveBeenCalled();
    expect(addToWhitelist).not.toHaveBeenCalled();
    expect(jobUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'job-WHITELIST_ADD', guildId: GUILD, status: 'RUNNING' },
      data: expect.objectContaining({ status: 'PENDING', attempts: 2 }),
    }));
  });

  it('dead-letters malformed whitelist payload before intent or token access', async () => {
    jobFindUnique.mockResolvedValue(job('WHITELIST_ADD', null));

    await executeJob(claim('job-WHITELIST_ADD'));

    expect(reconcileIntent).not.toHaveBeenCalled();
    expect(decrypt).not.toHaveBeenCalled();
    expect(addToWhitelist).not.toHaveBeenCalled();
    expect(jobUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'job-WHITELIST_ADD', guildId: GUILD, status: 'RUNNING' },
      data: expect.objectContaining({ status: 'DEAD', attempts: 2, lastError: 'payload.gameId fehlt' }),
    }));
  });
});
