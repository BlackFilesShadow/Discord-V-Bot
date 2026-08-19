const mockFindFirst = jest.fn();
const mockValidateTokenDetailed = jest.fn();
const mockDecrypt = jest.fn();
const mockMarkValidated = jest.fn();
const mockSetStatus = jest.fn();
const mockTryLock = jest.fn();
const mockRelease = jest.fn();

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: { nitradoConnection: { findFirst: (...args: unknown[]) => mockFindFirst(...args) } },
}));

jest.mock('../../src/config', () => ({
  config: { security: { encryptionKey: '0'.repeat(64) } },
}));

jest.mock('../../src/utils/security', () => ({
  decrypt: (...args: unknown[]) => mockDecrypt(...args),
}));

jest.mock('../../src/modules/nitrado/nitradoClient', () => ({
  NitradoClient: jest.fn().mockImplementation(() => ({ validateTokenDetailed: mockValidateTokenDetailed })),
}));

jest.mock('../../src/modules/nitrado/repository', () => ({
  markValidated: (...args: unknown[]) => mockMarkValidated(...args),
  setStatus: (...args: unknown[]) => mockSetStatus(...args),
}));

jest.mock('../../src/modules/nitrado/configMutationLock', () => ({
  tryAcquireNitradoConfigMutationLock: (...args: unknown[]) => mockTryLock(...args),
}));

import { revalidateConnectionMaintenanceOnce } from '../../src/modules/nitrado/maintenanceRevalidate';

const GUILD_ID = '123456789012345678';
const CONN_ID = 'c123456789012345678901234';
const CANDIDATE = { id: CONN_ID, guildId: GUILD_ID };
const FRESH = {
  id: CONN_ID,
  guildId: GUILD_ID,
  slot: 2,
  alias: 'Main',
  status: 'EXPIRED',
  encryptedToken: 'cipher-current',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockRelease.mockResolvedValue(undefined);
  mockTryLock.mockResolvedValue({ release: mockRelease });
  mockFindFirst.mockResolvedValue(FRESH);
  mockDecrypt.mockReturnValue('current-token');
  mockValidateTokenDetailed.mockResolvedValue({ kind: 'VALID' });
  mockMarkValidated.mockResolvedValue(undefined);
  mockSetStatus.mockResolvedValue(undefined);
});

describe('Nitrado-1Y maintenance revalidation freshness', () => {
  it('fails busy before reading or validating any stale candidate snapshot', async () => {
    mockTryLock.mockResolvedValueOnce(null);

    await expect(revalidateConnectionMaintenanceOnce(CANDIDATE)).resolves.toEqual({
      kind: 'BUSY', id: CONN_ID, guildId: GUILD_ID,
    });

    expect(mockFindFirst).not.toHaveBeenCalled();
    expect(mockValidateTokenDetailed).not.toHaveBeenCalled();
    expect(mockMarkValidated).not.toHaveBeenCalled();
    expect(mockSetStatus).not.toHaveBeenCalled();
  });

  it('reads the exact current Guild+Connection snapshot only after lock and reactivates through repository', async () => {
    const result = await revalidateConnectionMaintenanceOnce(CANDIDATE);

    expect(mockTryLock).toHaveBeenCalledWith(CONN_ID);
    expect(mockFindFirst).toHaveBeenCalledWith({
      where: {
        id: CONN_ID,
        guildId: GUILD_ID,
        status: { in: ['ACTIVE', 'EXPIRED'] },
      },
      select: {
        id: true,
        guildId: true,
        slot: true,
        alias: true,
        status: true,
        encryptedToken: true,
      },
    });
    expect(mockDecrypt).toHaveBeenCalledWith('cipher-current', '0'.repeat(64));
    expect(mockValidateTokenDetailed).toHaveBeenCalledTimes(1);
    expect(mockMarkValidated).toHaveBeenCalledWith(GUILD_ID, CONN_ID);
    expect(mockSetStatus).not.toHaveBeenCalled();
    expect(mockRelease).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ kind: 'VALID', id: CONN_ID, guildId: GUILD_ID, previousStatus: 'EXPIRED' });
  });

  it('marks only the freshly scoped connection EXPIRED on an actual INVALID result', async () => {
    mockValidateTokenDetailed.mockResolvedValueOnce({ kind: 'INVALID', status: 401 });

    await expect(revalidateConnectionMaintenanceOnce(CANDIDATE)).resolves.toMatchObject({
      kind: 'INVALID', status: 401, previousStatus: 'EXPIRED',
    });

    expect(mockSetStatus).toHaveBeenCalledWith(GUILD_ID, CONN_ID, 'EXPIRED');
    expect(mockMarkValidated).not.toHaveBeenCalled();
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it.each([
    { kind: 'RATE_LIMITED' },
    { kind: 'CIRCUIT_OPEN' },
    { kind: 'TRANSIENT_FAILURE', status: 503, message: 'upstream' },
  ])('keeps status unchanged for transient result $kind', async remoteResult => {
    mockValidateTokenDetailed.mockResolvedValueOnce(remoteResult);

    await expect(revalidateConnectionMaintenanceOnce(CANDIDATE)).resolves.toMatchObject({
      kind: 'TRANSIENT', previousStatus: 'EXPIRED', result: remoteResult,
    });

    expect(mockSetStatus).not.toHaveBeenCalled();
    expect(mockMarkValidated).not.toHaveBeenCalled();
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the connection changed/deleted before the lock-protected fresh read', async () => {
    mockFindFirst.mockResolvedValueOnce(null);

    await expect(revalidateConnectionMaintenanceOnce(CANDIDATE)).resolves.toEqual({
      kind: 'MISSING', id: CONN_ID, guildId: GUILD_ID,
    });

    expect(mockDecrypt).not.toHaveBeenCalled();
    expect(mockValidateTokenDetailed).not.toHaveBeenCalled();
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it('releases the connection lock even when remote validation throws', async () => {
    mockValidateTokenDetailed.mockRejectedValueOnce(new Error('network exploded'));

    await expect(revalidateConnectionMaintenanceOnce(CANDIDATE)).rejects.toThrow('network exploded');
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });
});
