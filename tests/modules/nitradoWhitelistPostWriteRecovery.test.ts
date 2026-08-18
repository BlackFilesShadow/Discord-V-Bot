const jobFindUnique = jest.fn();
const jobUpdateMany = jest.fn();
const connectionFindFirst = jest.fn();
const reconcileIntent = jest.fn();
const decrypt = jest.fn();
const addToWhitelist = jest.fn();
const pgQuery = jest.fn();
const pgConnect = jest.fn();
const pgEnd = jest.fn();

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
  NitradoClient: jest.fn().mockImplementation(() => ({ addToWhitelist })),
  NitradoApiError: class NitradoApiError extends Error {
    status: number;
    constructor(message: string, status: number) { super(message); this.status = status; }
  },
}));

jest.mock('../../src/modules/nitrado/whitelistIntent', () => ({
  reconcileWhitelistRemoteIntent: reconcileIntent,
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
  logAudit: jest.fn(),
}));
jest.mock('../../src/dashboard/socket/emitter', () => ({ emitGuildEvent: jest.fn() }));

import { executeJob } from '../../src/modules/nitrado/jobWorker';

const GUILD = '123456789012345678';
const CONN = 'c123456789012345678901234';

beforeEach(() => {
  jest.clearAllMocks();
  pgConnect.mockResolvedValue(undefined);
  pgEnd.mockResolvedValue(undefined);
  pgQuery
    .mockResolvedValueOnce({ rows: [{ locked: true }] })
    .mockResolvedValue({ rows: [] });
  jobUpdateMany.mockResolvedValue({ count: 1 });
  jobFindUnique.mockResolvedValue({
    id: 'job-add',
    guildId: GUILD,
    nitradoConnId: CONN,
    operation: 'WHITELIST_ADD',
    payload: { gameId: 'PlayerOne' },
    attempts: 0,
    maxAttempts: 8,
    status: 'RUNNING',
  });
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
});

describe('Nitrado-1B post-write crash recovery', () => {
  it('retries instead of marking DONE when the post-ADD intent reconciliation fails after remote success', async () => {
    reconcileIntent
      .mockResolvedValueOnce({
        execute: true,
        desiredState: 'PRESENT',
        reason: 'CURRENT_INTENT',
        compensationQueued: false,
      })
      .mockRejectedValueOnce(new Error('post-write db unavailable'));

    await executeJob('job-add');

    expect(addToWhitelist).toHaveBeenCalledWith('service-1', 'PlayerOne');
    expect(reconcileIntent).toHaveBeenCalledTimes(2);
    expect(jobUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'job-add', guildId: GUILD },
      data: expect.objectContaining({
        status: 'PENDING',
        attempts: 1,
        lastError: 'post-write db unavailable',
        nextRunAt: expect.any(Date),
      }),
    }));
    expect(jobUpdateMany).not.toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'DONE' }),
    }));
  });
});
