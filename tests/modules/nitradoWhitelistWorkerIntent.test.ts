const jobFindUnique = jest.fn();
const jobUpdateMany = jest.fn();
const connectionFindFirst = jest.fn();
const decideIntent = jest.fn();
const decrypt = jest.fn();
const addToWhitelist = jest.fn();
const removeFromWhitelist = jest.fn();
const audit = jest.fn();
const emit = jest.fn();
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
  decideWhitelistRemoteIntent: decideIntent,
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
  it('turns an old ADD retry into DONE without token/API work after a newer remove intent', async () => {
    jobFindUnique.mockResolvedValue(job('WHITELIST_ADD'));
    decideIntent.mockResolvedValue({
      execute: false,
      desiredState: 'PENDING_REMOVE',
      reason: 'SUPERSEDED_BY_REMOVE',
    });

    await executeJob('job-WHITELIST_ADD');

    expect(decideIntent).toHaveBeenCalledWith('WHITELIST_ADD', GUILD, CONN, 'PlayerOne');
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

  it('turns an old REMOVE retry into DONE after a newer re-add made PRESENT authoritative', async () => {
    jobFindUnique.mockResolvedValue(job('WHITELIST_REMOVE'));
    decideIntent.mockResolvedValue({
      execute: false,
      desiredState: 'PRESENT',
      reason: 'SUPERSEDED_BY_PRESENT',
    });

    await executeJob('job-WHITELIST_REMOVE');

    expect(decrypt).not.toHaveBeenCalled();
    expect(removeFromWhitelist).not.toHaveBeenCalled();
    expect(jobUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'job-WHITELIST_REMOVE', guildId: GUILD, status: 'RUNNING' },
      data: expect.objectContaining({ status: 'DONE' }),
    }));
  });

  it('executes current ADD intent and finishes through the normal DONE path', async () => {
    jobFindUnique.mockResolvedValue(job('WHITELIST_ADD'));
    decideIntent.mockResolvedValue({ execute: true, desiredState: 'PRESENT', reason: 'CURRENT_INTENT' });

    await executeJob('job-WHITELIST_ADD');

    expect(decrypt).toHaveBeenCalledWith('cipher', '0'.repeat(64));
    expect(addToWhitelist).toHaveBeenCalledWith('service-1', 'PlayerOne');
    expect(jobUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'job-WHITELIST_ADD', guildId: GUILD },
      data: expect.objectContaining({ status: 'DONE', lastError: null }),
    }));
  });

  it('keeps remote-only REMOVE executable when no local row exists', async () => {
    jobFindUnique.mockResolvedValue(job('WHITELIST_REMOVE', 'RemoteOnly'));
    decideIntent.mockResolvedValue({ execute: true, desiredState: 'UNTRACKED', reason: 'CURRENT_INTENT' });

    await executeJob('job-WHITELIST_REMOVE');

    expect(removeFromWhitelist).toHaveBeenCalledWith('service-1', 'RemoteOnly');
  });

  it('treats an intent lookup failure as retryable and performs no token/API work', async () => {
    jobFindUnique.mockResolvedValue(job('WHITELIST_ADD'));
    decideIntent.mockRejectedValue(new Error('db temporarily unavailable'));

    await executeJob('job-WHITELIST_ADD');

    expect(decrypt).not.toHaveBeenCalled();
    expect(addToWhitelist).not.toHaveBeenCalled();
    expect(jobUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'job-WHITELIST_ADD', guildId: GUILD },
      data: expect.objectContaining({ status: 'PENDING', attempts: 2 }),
    }));
  });

  it('dead-letters malformed whitelist payload before intent or token access', async () => {
    jobFindUnique.mockResolvedValue(job('WHITELIST_ADD', null));

    await executeJob('job-WHITELIST_ADD');

    expect(decideIntent).not.toHaveBeenCalled();
    expect(decrypt).not.toHaveBeenCalled();
    expect(addToWhitelist).not.toHaveBeenCalled();
    expect(jobUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'job-WHITELIST_ADD', guildId: GUILD },
      data: expect.objectContaining({ status: 'DEAD', attempts: 2, lastError: 'payload.gameId fehlt' }),
    }));
  });
});
