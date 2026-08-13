process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

/**
 * NIT-005/NIT-007: Fehler vor dem API-Aufruf duerfen keinen Job dauerhaft auf
 * RUNNING haengen lassen. Korrupter Token -> sofort DEAD. Unbekannte Operation
 * -> sofort DEAD (kein 8x-Retry).
 */
const updateManyMock = jest.fn(async () => ({ count: 1 }));
const jobStore: Record<string, unknown> = {};
const prismaMock = {
  nitradoJob: {
    findUnique: jest.fn(async ({ where }: { where: { id: string } }) => jobStore[where.id] ?? null),
    updateMany: updateManyMock,
  },
  nitradoConnection: {
    findFirst: jest.fn(async () => ({
      id: 'conn-1', guildId: 'g1', encryptedToken: 'enc', nitradoServerId: '123', status: 'ACTIVE',
    })),
  },
};
jest.mock('../../src/database/prisma', () => ({ __esModule: true, default: prismaMock }));
jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
}));
jest.mock('../../src/dashboard/socket/emitter', () => ({ __esModule: true, emitGuildEvent: jest.fn() }));

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

const decryptMock = jest.fn();
jest.mock('../../src/utils/security', () => ({ __esModule: true, decrypt: (...a: unknown[]) => decryptMock(...a) }));

const addToWhitelist = jest.fn();
const getServiceStatus = jest.fn();
const startService = jest.fn();
jest.mock('../../src/modules/nitrado/nitradoClient', () => ({
  __esModule: true,
  NitradoClient: jest.fn().mockImplementation(() => ({ addToWhitelist, getServiceStatus, start: startService })),
  NitradoApiError: class NitradoApiError extends Error { status: number | null = null; },
}));

import { executeJob, drainAndStopJobWorker, nitradoConnectionLockKeys } from '../../src/modules/nitrado/jobWorker';

function lastUpdateData(): Record<string, unknown> {
  const calls = updateManyMock.mock.calls as unknown as Array<[{ data: Record<string, unknown> }]>;
  return calls[calls.length - 1][0].data;
}

beforeEach(() => {
  jest.clearAllMocks();
  pgQuery.mockImplementation(async (sql: string) => {
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
    if (sql.includes('pg_advisory_unlock')) return { rows: [{ pg_advisory_unlock: true }] };
    return { rows: [] };
  });
  for (const k of Object.keys(jobStore)) delete jobStore[k];
});

describe('NIT-004 — per-Connection Multi-Instance-Lock', () => {
  it('leitet stabile Advisory-Lock-Keys pro Connection ab', () => {
    expect(nitradoConnectionLockKeys('conn-1')).toEqual(nitradoConnectionLockKeys('conn-1'));
    expect(nitradoConnectionLockKeys('conn-1')).not.toEqual(nitradoConnectionLockKeys('conn-2'));
  });

  it('requeued einen geclaimten Job, wenn eine andere Instanz den Connection-Lock haelt', async () => {
    jobStore['locked'] = { id: 'locked', guildId: 'g1', nitradoConnId: 'conn-1', operation: 'WHITELIST_ADD', payload: { gameId: 'player1' }, attempts: 0, maxAttempts: 8 };
    pgQuery.mockImplementationOnce(async () => ({ rows: [{ locked: false }] }));

    await executeJob('locked');

    expect(prismaMock.nitradoConnection.findFirst).not.toHaveBeenCalled();
    expect(addToWhitelist).not.toHaveBeenCalled();
    expect(lastUpdateData().status).toBe('PENDING');
    expect(pgEnd).toHaveBeenCalledTimes(1);
  });

  it('gibt einen gewonnenen Connection-Lock nach Jobabschluss wieder frei', async () => {
    jobStore['lock-release'] = { id: 'lock-release', guildId: 'g1', nitradoConnId: 'conn-1', operation: 'WHITELIST_ADD', payload: { gameId: 'player1' }, attempts: 0, maxAttempts: 8 };
    decryptMock.mockReturnValue('decrypted-token');
    addToWhitelist.mockResolvedValue(undefined);

    await executeJob('lock-release');

    expect(pgQuery.mock.calls.some(([sql]) => String(sql).includes('pg_try_advisory_lock'))).toBe(true);
    expect(pgQuery.mock.calls.some(([sql]) => String(sql).includes('pg_advisory_unlock'))).toBe(true);
    expect(pgEnd).toHaveBeenCalledTimes(1);
    expect(lastUpdateData().status).toBe('DONE');
  });
});

describe('NIT-005/007 — Job-Fehler vor API-Aufruf', () => {
  it('markiert Job DEAD wenn die Token-Entschluesselung fehlschlaegt', async () => {
    jobStore['j1'] = { id: 'j1', guildId: 'g1', nitradoConnId: 'conn-1', operation: 'WHITELIST_ADD', payload: { gameId: 'x' }, attempts: 0, maxAttempts: 8 };
    decryptMock.mockImplementation(() => { throw new Error('bad key'); });
    await executeJob('j1');
    expect(lastUpdateData().status).toBe('DEAD');
    expect(addToWhitelist).not.toHaveBeenCalled();
  });

  it('markiert unbekannte Operation sofort DEAD (kein Retry)', async () => {
    jobStore['j2'] = { id: 'j2', guildId: 'g1', nitradoConnId: 'conn-1', operation: 'FOO_BAR', payload: {}, attempts: 0, maxAttempts: 8 };
    await executeJob('j2');
    const data = lastUpdateData();
    expect(data.status).toBe('DEAD');
    expect(data.attempts).toBe(1);
    expect(decryptMock).not.toHaveBeenCalled();
  });

  it('fuehrt eine gueltige WHITELIST_ADD-Operation aus (DONE)', async () => {
    jobStore['j3'] = { id: 'j3', guildId: 'g1', nitradoConnId: 'conn-1', operation: 'WHITELIST_ADD', payload: { gameId: 'player1' }, attempts: 0, maxAttempts: 8 };
    decryptMock.mockReturnValue('decrypted-token');
    addToWhitelist.mockResolvedValue(undefined);
    await executeJob('j3');
    expect(addToWhitelist).toHaveBeenCalledWith('123', 'player1');
    expect(lastUpdateData().status).toBe('DONE');
  });
});

describe('KEEP-004 — RESTART_IF_DOWN respektiert administrative Zustaende', () => {
  beforeEach(() => {
    decryptMock.mockReturnValue('decrypted-token');
  });

  it('startet einen explizit gestoppten Service', async () => {
    jobStore['restart-stopped'] = { id: 'restart-stopped', guildId: 'g1', nitradoConnId: 'conn-1', operation: 'RESTART_IF_DOWN', payload: {}, attempts: 0, maxAttempts: 8 };
    getServiceStatus.mockResolvedValue('stopped');
    startService.mockResolvedValue(undefined);

    await executeJob('restart-stopped');

    expect(getServiceStatus).toHaveBeenCalledWith('123');
    expect(startService).toHaveBeenCalledWith('123');
    expect(lastUpdateData().status).toBe('DONE');
  });

  it('startet einen suspendierten Service niemals automatisch', async () => {
    jobStore['restart-suspended'] = { id: 'restart-suspended', guildId: 'g1', nitradoConnId: 'conn-1', operation: 'RESTART_IF_DOWN', payload: {}, attempts: 0, maxAttempts: 8 };
    getServiceStatus.mockResolvedValue('suspended');

    await executeJob('restart-suspended');

    expect(getServiceStatus).toHaveBeenCalledWith('123');
    expect(startService).not.toHaveBeenCalled();
    expect(lastUpdateData().status).toBe('DONE');
  });
});

describe('NIT-010 — drainAndStopJobWorker', () => {
  it('resolved ohne laufenden Poll sofort', async () => {
    await expect(drainAndStopJobWorker(200)).resolves.toBeUndefined();
  });
});
