process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

/**
 * Nitrado-1M: Verhaltensnachweis fuer die produktive Remote-Fehlermatrix des
 * NitradoJob-Workers. Der vorhandene Architektur-Gate aus 1K beweist die
 * Klassifizierungsformel statisch; diese Suite beweist ihre tatsaechliche
 * Wirkung auf Jobzustand, Attempts und Keep-Online-Statusentscheidungen.
 */
const transitions: Array<Record<string, unknown>> = [];
const jobStore: Record<string, Record<string, unknown>> = {};
const connectionFindFirst = jest.fn();
const reconcileWhitelistIntent = jest.fn();

type TestClaim = { id: string; guildId: string; claimToken: string };

const prismaMock = {
  nitradoJob: {
    findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
      const row = jobStore[where.id];
      return row ? { ...row, status: 'RUNNING' } : null;
    }),
    findMany: jest.fn(async () => []),
    create: jest.fn(async () => ({})),
    updateMany: jest.fn(async () => ({ count: 1 })),
  },
  nitradoConnection: { findFirst: connectionFindFirst },
  serverBanEntry: {
    findFirst: jest.fn(),
    findMany: jest.fn(async () => []),
    updateMany: jest.fn(async () => ({ count: 1 })),
  },
};

jest.mock('../../src/database/prisma', () => ({ __esModule: true, default: prismaMock }));
jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
}));
jest.mock('../../src/dashboard/socket/emitter', () => ({ __esModule: true, emitGuildEvent: jest.fn() }));
jest.mock('../../src/config', () => ({ config: { security: { encryptionKey: '0'.repeat(64) } } }));

const pgConnect = jest.fn(async () => undefined);
const pgEnd = jest.fn(async () => undefined);
const pgQuery = jest.fn(async (sql: string) => {
  if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
  if (sql.includes('pg_advisory_unlock')) return { rows: [{ pg_advisory_unlock: true }] };
  return { rows: [] };
});
jest.mock('pg', () => ({
  __esModule: true,
  Client: jest.fn().mockImplementation(() => ({ connect: pgConnect, query: pgQuery, end: pgEnd })),
}));

const decryptMock = jest.fn((..._args: unknown[]) => 'decrypted-token');
const addToWhitelist = jest.fn(async () => undefined);
const removeFromWhitelist = jest.fn(async () => undefined);
const getServiceStatus = jest.fn(async () => 'started');
const startService = jest.fn(async () => undefined);
const validateToken = jest.fn(async () => true);
const getBanlist = jest.fn(async () => []);
const addToBanlist = jest.fn(async () => undefined);
const removeFromBanlist = jest.fn(async () => undefined);

jest.mock('../../src/utils/security', () => ({
  __esModule: true,
  decrypt: (...args: unknown[]) => decryptMock(...args),
  encrypt: jest.fn((value: string) => `cipher:${value}`),
}));

jest.mock('../../src/modules/nitrado/nitradoClient', () => ({
  __esModule: true,
  NitradoApiError: class NitradoApiError extends Error {
    constructor(
      message: string,
      public readonly status: number | null,
      public readonly endpoint = '/test',
    ) {
      super(message);
      this.name = 'NitradoApiError';
    }
  },
  NitradoClient: jest.fn().mockImplementation(() => ({
    addToWhitelist,
    removeFromWhitelist,
    getServiceStatus,
    start: startService,
    validateToken,
    getBanlist,
    addToBanlist,
    removeFromBanlist,
  })),
}));

jest.mock('../../src/modules/nitrado/whitelistIntent', () => ({
  reconcileWhitelistRemoteIntent: (...args: unknown[]) => reconcileWhitelistIntent(...args),
}));
jest.mock('../../src/modules/nitrado/jobLease', () => ({
  NITRADO_JOB_HEARTBEAT_INTERVAL_MS: 60_000,
  claimNitradoJob: jest.fn(),
  heartbeatNitradoJobClaim: jest.fn(async () => true),
  recoverStaleNitradoJobClaims: jest.fn(async () => 0),
  transitionClaimedNitradoJob: jest.fn(async (_claim: TestClaim, data: Record<string, unknown>) => {
    transitions.push(data);
    return true;
  }),
}));
jest.mock('../../src/modules/bans/banRegistry', () => ({ isBanActive: jest.fn(() => false) }));
jest.mock('../../src/modules/bans/banTarget', () => ({ matchesBanIdentifier: jest.fn(() => false) }));
jest.mock('../../src/modules/bans/banOutbox', () => ({
  enqueueServerBanAdd: jest.fn(async () => true),
  enqueueServerBanRemove: jest.fn(async () => true),
  parseServerBanJobPayload: jest.fn((value: unknown) => value),
}));

import { NitradoApiError } from '../../src/modules/nitrado/nitradoClient';
import { executeJob } from '../../src/modules/nitrado/jobWorker';

function claim(id: string): TestClaim {
  return { id, guildId: 'g1', claimToken: `claim:${id}` };
}

function addJob(
  id: string,
  operation: string,
  payload: unknown = {},
  attempts = 0,
  maxAttempts = 3,
): void {
  jobStore[id] = {
    id,
    guildId: 'g1',
    nitradoConnId: 'conn-1',
    operation,
    payload,
    attempts,
    maxAttempts,
  };
}

function lastTransition(): Record<string, unknown> {
  expect(transitions.length).toBeGreaterThan(0);
  return transitions[transitions.length - 1];
}

beforeEach(() => {
  jest.clearAllMocks();
  transitions.length = 0;
  for (const key of Object.keys(jobStore)) delete jobStore[key];

  pgConnect.mockResolvedValue(undefined);
  pgEnd.mockResolvedValue(undefined);
  pgQuery.mockImplementation(async (sql: string) => {
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
    if (sql.includes('pg_advisory_unlock')) return { rows: [{ pg_advisory_unlock: true }] };
    return { rows: [] };
  });

  connectionFindFirst.mockResolvedValue({
    id: 'conn-1',
    guildId: 'g1',
    encryptedToken: 'enc',
    nitradoServerId: '123',
    status: 'ACTIVE',
    keepOnlineEnabled: true,
  });
  reconcileWhitelistIntent.mockResolvedValue({
    execute: true,
    desiredState: 'PRESENT',
    reason: 'CURRENT_INTENT',
    compensationQueued: false,
  });
  decryptMock.mockReturnValue('decrypted-token');
  addToWhitelist.mockResolvedValue(undefined);
  removeFromWhitelist.mockResolvedValue(undefined);
  getServiceStatus.mockResolvedValue('started');
  startService.mockResolvedValue(undefined);
  validateToken.mockResolvedValue(true);
});

describe('Nitrado-1M — Worker HTTP-/Transport-Fehlermatrix', () => {
  it.each([401, 403, 404])('setzt WHITELIST_ADD bei HTTP %s sofort DEAD', async status => {
    const id = `http-${status}`;
    addJob(id, 'WHITELIST_ADD', { gameId: 'player-1' });
    addToWhitelist.mockRejectedValueOnce(new NitradoApiError(`HTTP ${status}`, status, '/whitelist'));

    await executeJob(claim(id));

    expect(lastTransition()).toMatchObject({
      status: 'DEAD',
      attempts: 1,
      lastError: `HTTP ${status}`,
    });
  });

  it('haelt HTTP 429 retrybar und verbraucht genau einen Worker-Attempt', async () => {
    addJob('http-429', 'WHITELIST_ADD', { gameId: 'player-1' });
    addToWhitelist.mockRejectedValueOnce(new NitradoApiError('Rate-Limit', 429, '/whitelist'));
    const before = Date.now();

    await executeJob(claim('http-429'));

    const transition = lastTransition();
    expect(transition).toMatchObject({ status: 'PENDING', attempts: 1, lastError: 'Rate-Limit' });
    expect((transition.nextRunAt as Date).getTime()).toBeGreaterThanOrEqual(before + 29_000);
  });

  it('haelt HTTP 500 retrybar', async () => {
    addJob('http-500', 'WHITELIST_ADD', { gameId: 'player-1' });
    addToWhitelist.mockRejectedValueOnce(new NitradoApiError('server error', 500, '/whitelist'));

    await executeJob(claim('http-500'));

    expect(lastTransition()).toMatchObject({ status: 'PENDING', attempts: 1, lastError: 'server error' });
  });

  it('haelt einen bereits intern ausgereizten Transport-/Timeoutfehler retrybar', async () => {
    addJob('timeout', 'WHITELIST_ADD', { gameId: 'player-1' });
    addToWhitelist.mockRejectedValueOnce(new NitradoApiError('timeout', null, '/whitelist'));

    await executeJob(claim('timeout'));

    expect(lastTransition()).toMatchObject({ status: 'PENDING', attempts: 1, lastError: 'timeout' });
  });

  it('beendet auch transiente Fehler bounded auf DEAD sobald maxAttempts erreicht ist', async () => {
    addJob('bounded-500', 'WHITELIST_ADD', { gameId: 'player-1' }, 2, 3);
    addToWhitelist.mockRejectedValueOnce(new NitradoApiError('server error', 500, '/whitelist'));

    await executeJob(claim('bounded-500'));

    expect(lastTransition()).toMatchObject({ status: 'DEAD', attempts: 3, lastError: 'server error' });
  });
});

describe('Nitrado-1M — Keep-Online Remote-Statusmatrix', () => {
  it('startet nur den expliziten Zustand stopped', async () => {
    addJob('state-stopped', 'RESTART_IF_DOWN');
    getServiceStatus.mockResolvedValueOnce('stopped');

    await executeJob(claim('state-stopped'));

    expect(startService).toHaveBeenCalledTimes(1);
    expect(startService).toHaveBeenCalledWith('123');
    expect(lastTransition().status).toBe('DONE');
  });

  it.each(['started', 'restarting', 'suspended', 'unknown'])('startet den administrativen Zustand %s nicht', async state => {
    const id = `state-${state}`;
    addJob(id, 'RESTART_IF_DOWN');
    getServiceStatus.mockResolvedValueOnce(state);

    await executeJob(claim(id));

    expect(startService).not.toHaveBeenCalled();
    expect(lastTransition().status).toBe('DONE');
  });

  it('retryt einen 5xx-Fehler bereits bei der Statusabfrage statt blind zu starten', async () => {
    addJob('state-api-failure', 'RESTART_IF_DOWN');
    getServiceStatus.mockRejectedValueOnce(new NitradoApiError('status unavailable', 503, '/gameservers'));

    await executeJob(claim('state-api-failure'));

    expect(startService).not.toHaveBeenCalled();
    expect(lastTransition()).toMatchObject({ status: 'PENDING', attempts: 1, lastError: 'status unavailable' });
  });
});
