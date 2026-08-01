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

const decryptMock = jest.fn();
jest.mock('../../src/utils/security', () => ({ __esModule: true, decrypt: (...a: unknown[]) => decryptMock(...a) }));

const addToWhitelist = jest.fn();
jest.mock('../../src/modules/nitrado/nitradoClient', () => ({
  __esModule: true,
  NitradoClient: jest.fn().mockImplementation(() => ({ addToWhitelist })),
  NitradoApiError: class NitradoApiError extends Error { status: number | null = null; },
}));

import { executeJob, drainAndStopJobWorker } from '../../src/modules/nitrado/jobWorker';

function lastUpdateData(): Record<string, unknown> {
  const calls = updateManyMock.mock.calls as unknown as Array<[{ data: Record<string, unknown> }]>;
  return calls[calls.length - 1][0].data;
}

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of Object.keys(jobStore)) delete jobStore[k];
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

describe('NIT-010 — drainAndStopJobWorker', () => {
  it('resolved ohne laufenden Poll sofort', async () => {
    await expect(drainAndStopJobWorker(200)).resolves.toBeUndefined();
  });
});
