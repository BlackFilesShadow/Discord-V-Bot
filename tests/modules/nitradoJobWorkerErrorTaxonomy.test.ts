process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

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

const decryptMock = jest.fn(() => 'decrypted-token');
const addToWhitelist = jest.fn(async () => undefined);
const removeFromWhitelist = jest.fn(async () => undefined);
const getServiceStatus = jest.fn(async () => 'started');
const startService = jest.fn(async () => undefined);
jest.mock('../../src/utils/security', () => ({
  __esModule: true,
  decrypt: (...args: unknown[]) => decryptMock(...args),
  encrypt: jest.fn((value: string) => `cipher:${value}`),
}));
jest.mock('../../src/modules/nitrado/nitradoClient', () => ({
  __esModule: true,
  NitradoClient: jest.fn().mockImplementation(() => ({
    addToWhitelist,
    removeFromWhitelist,
    getServiceStatus,
    start: startService,
    validateToken: jest.fn(async () => true),
    getBanlist: jest.fn(async () => []),
    addToBanlist: jest.fn(async () => undefined),
    removeFromBanlist: jest.fn(async () => undefined),
  })),
  NitradoApiError: class NitradoApiError extends Error {
    constructor(message: string, public readonly status: number | null = null) { super(message); }
  },
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
  parseServerBanJobPayload: (value: unknown) => {
    if (!value || typeof value !== 'object' || typeof (value as { banId?: unknown }).banId !== 'string') {
      throw new Error('Ungueltige Server-Ban-Job-Payload');
    }
    return value as { banId: string; encryptedIdentifier?: string };
  },
}));

import { executeJob } from '../../src/modules/nitrado/jobWorker';

function claim(id: string): TestClaim {
  return { id, guildId: 'g1', claimToken: `claim:${id}` };
}

function addJob(id: string, operation: string, payload: unknown = {}, attempts = 0, maxAttempts = 3): void {
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
});

describe('Nitrado-1K worker error taxonomy', () => {
  it('behandelt normalen Connection-Lock-Contention als schnellen Requeue ohne Attempt-Verbrauch', async () => {
    addJob('busy-lock', 'WHITELIST_ADD', { gameId: 'player-1' });
    pgQuery.mockImplementationOnce(async () => ({ rows: [{ locked: false }] }));

    await executeJob(claim('busy-lock'));

    const transition = lastTransition();
    expect(transition.status).toBe('PENDING');
    expect(transition).not.toHaveProperty('attempts');
    expect(connectionFindFirst).not.toHaveBeenCalled();
  });

  it('behandelt PostgreSQL-Lock-Infrastrukturfehler als bounded transient Retry mit Attempt', async () => {
    addJob('lock-error', 'WHITELIST_ADD', { gameId: 'player-1' });
    pgConnect.mockRejectedValueOnce(new Error('db unavailable'));
    const before = Date.now();

    await executeJob(claim('lock-error'));

    const transition = lastTransition();
    expect(transition.status).toBe('PENDING');
    expect(transition.attempts).toBe(1);
    expect(String(transition.lastError)).toContain('Connection-Lock-Infrastruktur fehlgeschlagen');
    expect((transition.nextRunAt as Date).getTime()).toBeGreaterThanOrEqual(before + 29_000);
    expect(pgEnd).toHaveBeenCalledTimes(1);
    expect(connectionFindFirst).not.toHaveBeenCalled();
  });

  it('behandelt einen transienten Connection-Lookup-Fehler nicht als sofort DEAD', async () => {
    addJob('lookup-error', 'WHITELIST_ADD', { gameId: 'player-1' });
    connectionFindFirst.mockRejectedValueOnce(new Error('temporary database outage'));

    await executeJob(claim('lookup-error'));

    const transition = lastTransition();
    expect(transition.status).toBe('PENDING');
    expect(transition.attempts).toBe(1);
    expect(String(transition.lastError)).toContain('Connection-Lookup fehlgeschlagen');
  });

  it('setzt dauerhaft fehlende Whitelist-Service-Konfiguration sofort DEAD', async () => {
    addJob('missing-service-whitelist', 'WHITELIST_ADD', { gameId: 'player-1' });
    connectionFindFirst.mockResolvedValueOnce({
      id: 'conn-1', guildId: 'g1', encryptedToken: 'enc', nitradoServerId: null, status: 'ACTIVE', keepOnlineEnabled: true,
    });

    await executeJob(claim('missing-service-whitelist'));

    const transition = lastTransition();
    expect(transition.status).toBe('DEAD');
    expect(transition.attempts).toBe(1);
    expect(transition.lastError).toBe('Kein nitradoServerId fuer WHITELIST_ADD');
    expect(addToWhitelist).not.toHaveBeenCalled();
  });

  it('setzt dauerhaft fehlende Keep-Online-Service-Konfiguration sofort DEAD', async () => {
    addJob('missing-service-restart', 'RESTART_IF_DOWN');
    connectionFindFirst.mockResolvedValueOnce({
      id: 'conn-1', guildId: 'g1', encryptedToken: 'enc', nitradoServerId: null, status: 'ACTIVE', keepOnlineEnabled: true,
    });

    await executeJob(claim('missing-service-restart'));

    const transition = lastTransition();
    expect(transition.status).toBe('DEAD');
    expect(transition.attempts).toBe(1);
    expect(transition.lastError).toBe('Kein nitradoServerId fuer RESTART_IF_DOWN');
    expect(startService).not.toHaveBeenCalled();
  });

  it('klassifiziert eine kaputte Server-Ban-Payload sofort permanent und scrubbt sie', async () => {
    addJob('bad-ban-payload', 'SERVER_BAN_REMOVE', {});

    await executeJob(claim('bad-ban-payload'));

    const transition = lastTransition();
    expect(transition.status).toBe('DEAD');
    expect(transition.attempts).toBe(1);
    expect(transition.lastError).toBe('Ungueltige Server-Ban-Job-Payload');
    expect(transition.payload).toEqual({});
  });
});
