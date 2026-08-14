process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

/**
 * NIT-005/NIT-007 + Phase-7 Remote-Bans: Fehler vor dem API-Aufruf duerfen
 * keinen Job dauerhaft auf RUNNING haengen lassen. Server-Ban-Jobs muessen
 * HMAC-geprueft, scope-sicher, race-sicher und payload-gescrubbt sein.
 */
const updateManyMock = jest.fn(async () => ({ count: 1 }));
const jobFindManyMock = jest.fn(async () => [] as Array<{ payload: unknown }>);
const jobCreateMock = jest.fn(async () => ({}));
const serverBanFindFirstMock = jest.fn();
const serverBanFindManyMock = jest.fn(async () => []);
const serverBanUpdateManyMock = jest.fn(async () => ({ count: 1 }));
const jobStore: Record<string, unknown> = {};
const prismaMock = {
  nitradoJob: {
    findUnique: jest.fn(async ({ where }: { where: { id: string } }) => jobStore[where.id] ?? null),
    findMany: jobFindManyMock,
    create: jobCreateMock,
    updateMany: updateManyMock,
  },
  nitradoConnection: {
    findFirst: jest.fn(async () => ({
      id: 'conn-1', guildId: 'g1', encryptedToken: 'enc', nitradoServerId: '123', status: 'ACTIVE', keepOnlineEnabled: true,
    })),
  },
  serverBanEntry: {
    findFirst: serverBanFindFirstMock,
    findMany: serverBanFindManyMock,
    updateMany: serverBanUpdateManyMock,
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
const encryptMock = jest.fn((text: string) => `cipher:${text}`);
jest.mock('../../src/utils/security', () => ({
  __esModule: true,
  decrypt: (...a: unknown[]) => decryptMock(...a),
  encrypt: encryptMock,
}));

const addToWhitelist = jest.fn();
const getServiceStatus = jest.fn();
const startService = jest.fn();
const getBanlist = jest.fn();
const addToBanlist = jest.fn();
const removeFromBanlist = jest.fn();
jest.mock('../../src/modules/nitrado/nitradoClient', () => ({
  __esModule: true,
  NitradoClient: jest.fn().mockImplementation(() => ({
    addToWhitelist,
    getServiceStatus,
    start: startService,
    getBanlist,
    addToBanlist,
    removeFromBanlist,
  })),
  NitradoApiError: class NitradoApiError extends Error { status: number | null = null; },
}));

import { executeJob, drainAndStopJobWorker, nitradoConnectionLockKeys } from '../../src/modules/nitrado/jobWorker';
import { identityHash } from '../../src/modules/linking/identity';

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
  prismaMock.nitradoConnection.findFirst.mockImplementation(async () => ({
    id: 'conn-1', guildId: 'g1', encryptedToken: 'enc', nitradoServerId: '123', status: 'ACTIVE', keepOnlineEnabled: true,
  }));
  serverBanFindFirstMock.mockReset();
  serverBanFindManyMock.mockResolvedValue([]);
  serverBanUpdateManyMock.mockResolvedValue({ count: 1 });
  jobFindManyMock.mockResolvedValue([]);
  jobCreateMock.mockResolvedValue({});
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

describe('Phase 7 — SERVER_BAN Outbox', () => {
  const key = process.env.ENCRYPTION_KEY!;
  const rawIdentifier = '76561198000000000';
  const hash = identityHash(rawIdentifier, key);

  beforeEach(() => {
    decryptMock.mockImplementation((value: string) => value === 'enc' ? 'decrypted-token' : rawIdentifier);
    getBanlist.mockResolvedValue([]);
    addToBanlist.mockResolvedValue(undefined);
    removeFromBanlist.mockResolvedValue(undefined);
  });

  it('setzt einen HMAC-verifizierten Remote-Bann und scrubbt die Job-Payload', async () => {
    jobStore['ban-add'] = {
      id: 'ban-add', guildId: 'g1', nitradoConnId: 'conn-1', operation: 'SERVER_BAN_ADD',
      payload: { banId: 'ban-1', encryptedIdentifier: 'ciphertext' }, attempts: 0, maxAttempts: 8,
    };
    serverBanFindFirstMock
      .mockResolvedValueOnce({ id: 'ban-1', identityHash: hash, active: true, expiresAt: null, appliedRemotely: false })
      .mockResolvedValueOnce({ active: true, expiresAt: null });

    await executeJob('ban-add');

    expect(getBanlist).toHaveBeenCalledWith('123');
    expect(addToBanlist).toHaveBeenCalledWith('123', rawIdentifier);
    expect(serverBanUpdateManyMock).toHaveBeenCalledWith(expect.objectContaining({
      data: { appliedRemotely: true },
    }));
    expect(lastUpdateData()).toMatchObject({ status: 'DONE', payload: {} });
  });

  it('behandelt bereits vorhandenen Remote-Bann idempotent ohne zweiten POST', async () => {
    jobStore['ban-add-existing'] = {
      id: 'ban-add-existing', guildId: 'g1', nitradoConnId: 'conn-1', operation: 'SERVER_BAN_ADD',
      payload: { banId: 'ban-1', encryptedIdentifier: 'ciphertext' }, attempts: 0, maxAttempts: 8,
    };
    serverBanFindFirstMock
      .mockResolvedValueOnce({ id: 'ban-1', identityHash: hash, active: true, expiresAt: null, appliedRemotely: false })
      .mockResolvedValueOnce({ active: true, expiresAt: null });
    getBanlist.mockResolvedValue([{ identifier: rawIdentifier }]);

    await executeJob('ban-add-existing');

    expect(addToBanlist).not.toHaveBeenCalled();
    expect(serverBanUpdateManyMock).toHaveBeenCalledWith(expect.objectContaining({ data: { appliedRemotely: true } }));
    expect(lastUpdateData().status).toBe('DONE');
  });

  it('verweigert einen Identifier, dessen HMAC nicht zum Ban-Eintrag passt', async () => {
    jobStore['ban-bad-id'] = {
      id: 'ban-bad-id', guildId: 'g1', nitradoConnId: 'conn-1', operation: 'SERVER_BAN_ADD',
      payload: { banId: 'ban-1', encryptedIdentifier: 'ciphertext' }, attempts: 0, maxAttempts: 8,
    };
    serverBanFindFirstMock.mockResolvedValueOnce({
      id: 'ban-1', identityHash: identityHash('different-player', key), active: true, expiresAt: null, appliedRemotely: false,
    });

    await executeJob('ban-bad-id');

    expect(getBanlist).not.toHaveBeenCalled();
    expect(addToBanlist).not.toHaveBeenCalled();
    expect(lastUpdateData()).toMatchObject({ status: 'DEAD', payload: {} });
  });

  it('fuehrt einen stale ADD nach lokalem Unban niemals remote aus', async () => {
    jobStore['ban-stale-add'] = {
      id: 'ban-stale-add', guildId: 'g1', nitradoConnId: 'conn-1', operation: 'SERVER_BAN_ADD',
      payload: { banId: 'ban-1', encryptedIdentifier: 'ciphertext' }, attempts: 0, maxAttempts: 8,
    };
    serverBanFindFirstMock.mockResolvedValueOnce({
      id: 'ban-1', identityHash: hash, active: false, expiresAt: null, appliedRemotely: false,
    });

    await executeJob('ban-stale-add');

    expect(getBanlist).not.toHaveBeenCalled();
    expect(addToBanlist).not.toHaveBeenCalled();
    expect(lastUpdateData()).toMatchObject({ status: 'DONE', payload: {} });
  });

  it('loest Remote-Unban-Identifier nur live aus der Nitrado-Banlist per HMAC auf', async () => {
    jobStore['ban-remove'] = {
      id: 'ban-remove', guildId: 'g1', nitradoConnId: 'conn-1', operation: 'SERVER_BAN_REMOVE',
      payload: { banId: 'ban-1' }, attempts: 0, maxAttempts: 8,
    };
    serverBanFindFirstMock
      .mockResolvedValueOnce({ id: 'ban-1', identityHash: hash, active: false, expiresAt: null, appliedRemotely: true })
      .mockResolvedValueOnce({ active: false, expiresAt: null });
    getBanlist.mockResolvedValue([{ identifier: 'other' }, { identifier: rawIdentifier }]);

    await executeJob('ban-remove');

    expect(removeFromBanlist).toHaveBeenCalledWith('123', rawIdentifier);
    expect(serverBanUpdateManyMock).toHaveBeenCalledWith(expect.objectContaining({ data: { appliedRemotely: false } }));
    expect(lastUpdateData()).toMatchObject({ status: 'DONE', payload: {} });
  });

  it('interpretiert fehlenden HMAC-Match als bereits remote entfernt', async () => {
    jobStore['ban-remove-gone'] = {
      id: 'ban-remove-gone', guildId: 'g1', nitradoConnId: 'conn-1', operation: 'SERVER_BAN_REMOVE',
      payload: { banId: 'ban-1' }, attempts: 0, maxAttempts: 8,
    };
    serverBanFindFirstMock
      .mockResolvedValueOnce({ id: 'ban-1', identityHash: hash, active: false, expiresAt: null, appliedRemotely: true })
      .mockResolvedValueOnce({ active: false, expiresAt: null });
    getBanlist.mockResolvedValue([{ identifier: 'other' }]);

    await executeJob('ban-remove-gone');

    expect(removeFromBanlist).not.toHaveBeenCalled();
    expect(serverBanUpdateManyMock).toHaveBeenCalledWith(expect.objectContaining({ data: { appliedRemotely: false } }));
    expect(lastUpdateData().status).toBe('DONE');
  });

  it('fuehrt einen stale REMOVE nach Re-Ban niemals remote aus', async () => {
    jobStore['ban-stale-remove'] = {
      id: 'ban-stale-remove', guildId: 'g1', nitradoConnId: 'conn-1', operation: 'SERVER_BAN_REMOVE',
      payload: { banId: 'ban-1' }, attempts: 0, maxAttempts: 8,
    };
    serverBanFindFirstMock.mockResolvedValueOnce({
      id: 'ban-1', identityHash: hash, active: true, expiresAt: null, appliedRemotely: true,
    });

    await executeJob('ban-stale-remove');

    expect(getBanlist).not.toHaveBeenCalled();
    expect(removeFromBanlist).not.toHaveBeenCalled();
    expect(lastUpdateData()).toMatchObject({ status: 'DONE', payload: {} });
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

  it('macht bei bereits deaktiviertem Keep-Online keinen Remote-Status- oder Start-Aufruf', async () => {
    jobStore['restart-disabled'] = { id: 'restart-disabled', guildId: 'g1', nitradoConnId: 'conn-1', operation: 'RESTART_IF_DOWN', payload: {}, attempts: 0, maxAttempts: 8 };
    prismaMock.nitradoConnection.findFirst.mockResolvedValueOnce({
      id: 'conn-1', guildId: 'g1', encryptedToken: 'enc', nitradoServerId: '123', status: 'ACTIVE', keepOnlineEnabled: false,
    });

    await executeJob('restart-disabled');

    expect(getServiceStatus).not.toHaveBeenCalled();
    expect(startService).not.toHaveBeenCalled();
    expect(lastUpdateData().status).toBe('DONE');
  });

  it('verwirft den Auto-Start wenn Keep-Online waehrend der Statusabfrage deaktiviert wird', async () => {
    jobStore['restart-disable-race'] = { id: 'restart-disable-race', guildId: 'g1', nitradoConnId: 'conn-1', operation: 'RESTART_IF_DOWN', payload: {}, attempts: 0, maxAttempts: 8 };
    prismaMock.nitradoConnection.findFirst
      .mockResolvedValueOnce({
        id: 'conn-1', guildId: 'g1', encryptedToken: 'enc', nitradoServerId: '123', status: 'ACTIVE', keepOnlineEnabled: true,
      })
      .mockResolvedValueOnce({
        id: 'conn-1', guildId: 'g1', encryptedToken: 'enc', nitradoServerId: '123', status: 'ACTIVE', keepOnlineEnabled: false,
      });
    getServiceStatus.mockResolvedValue('stopped');

    await executeJob('restart-disable-race');

    expect(getServiceStatus).toHaveBeenCalledWith('123');
    expect(startService).not.toHaveBeenCalled();
    expect(prismaMock.nitradoConnection.findFirst).toHaveBeenCalledTimes(2);
    expect(lastUpdateData().status).toBe('DONE');
  });
});

describe('NIT-010 — drainAndStopJobWorker', () => {
  it('resolved ohne laufenden Poll sofort', async () => {
    await expect(drainAndStopJobWorker(200)).resolves.toBeUndefined();
  });
});
