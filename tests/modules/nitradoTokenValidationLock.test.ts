process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

const findFirst = jest.fn();
const updateMany = jest.fn();
const decrypt = jest.fn();
const validateTokenDetailed = jest.fn();
const markValidated = jest.fn();
const setStatus = jest.fn();
const recordValidationFailure = jest.fn();
const acquireLock = jest.fn(async (_nitradoConnId: string) => null as { release: () => Promise<void> } | null);
const releaseLock = jest.fn();
const warn = jest.fn();
const debug = jest.fn();

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    nitradoConnection: {
      findFirst,
      findMany: jest.fn(),
      updateMany,
    },
  },
}));

jest.mock('../../src/config', () => ({
  config: {
    security: { encryptionKey: 'test-encryption-key' },
    dashboard: { url: 'http://localhost:3000', port: 3000 },
  },
}));

jest.mock('../../src/utils/security', () => ({ decrypt }));

jest.mock('../../src/modules/nitrado/nitradoClient', () => ({
  NitradoClient: jest.fn().mockImplementation(() => ({ validateTokenDetailed })),
}));

jest.mock('../../src/modules/nitrado/repository', () => ({
  markValidated: (...args: unknown[]) => markValidated(...args),
  setStatus: (...args: unknown[]) => setStatus(...args),
}));

jest.mock('../../src/modules/nitrado/validationHealth', () => ({
  recordValidationFailure: (...args: unknown[]) => recordValidationFailure(...args),
  sanitizeValidationError: (value: unknown) => value instanceof Error ? value.message : String(value),
}));

jest.mock('../../src/modules/nitrado/configMutationLock', () => ({
  tryAcquireNitradoConfigMutationLock: (nitradoConnId: string) => acquireLock(nitradoConnId),
}));

jest.mock('../../src/utils/logger', () => ({
  logger: { warn, debug, info: jest.fn(), error: jest.fn() },
  logAudit: jest.fn(),
}));

import { validateConnectionTokenOnce } from '../../src/modules/nitrado/tokenValidationCron';

const SCAN = {
  id: 'c123456789012345678901234',
  guildId: '123456789012345678',
  alias: 'Main',
  alias5: 'ABCDE',
  status: 'ACTIVE',
  encryptedToken: 'scan-old-cipher',
};
const FRESH = { ...SCAN, encryptedToken: 'fresh-cipher' };
const discord = {
  guilds: { cache: { get: jest.fn(() => undefined) } },
} as never;

beforeEach(() => {
  jest.clearAllMocks();
  releaseLock.mockResolvedValue(undefined);
  acquireLock.mockResolvedValue({ release: releaseLock });
  findFirst.mockResolvedValue(FRESH);
  decrypt.mockReturnValue('fresh-token');
  validateTokenDetailed.mockResolvedValue({ kind: 'VALID' });
  markValidated.mockResolvedValue(undefined);
  setStatus.mockResolvedValue(undefined);
  recordValidationFailure.mockResolvedValue({
    failureCount: 1,
    shouldAlert: false,
    safeMessage: 'safe',
  });
  updateMany.mockResolvedValue({ count: 1 });
});

describe('Nitrado-1D token validation snapshot/worker lock', () => {
  it('does nothing and does not count a token failure while the connection is busy', async () => {
    acquireLock.mockResolvedValue(null);

    await validateConnectionTokenOnce(discord, SCAN);

    expect(acquireLock).toHaveBeenCalledWith(SCAN.id);
    expect(findFirst).not.toHaveBeenCalled();
    expect(decrypt).not.toHaveBeenCalled();
    expect(validateTokenDetailed).not.toHaveBeenCalled();
    expect(recordValidationFailure).not.toHaveBeenCalled();
    expect(markValidated).not.toHaveBeenCalled();
    expect(setStatus).not.toHaveBeenCalled();
    expect(releaseLock).not.toHaveBeenCalled();
  });

  it('treats advisory-lock infrastructure failure as infrastructure, not token health', async () => {
    acquireLock.mockRejectedValue(new Error('postgres unavailable'));

    await validateConnectionTokenOnce(discord, SCAN);

    expect(recordValidationFailure).not.toHaveBeenCalled();
    expect(findFirst).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Token-Validation-Lock'));
  });

  it('re-reads after lock acquisition and validates the fresh token instead of the scan snapshot', async () => {
    await validateConnectionTokenOnce(discord, SCAN);

    expect(findFirst).toHaveBeenCalledWith({
      where: {
        id: SCAN.id,
        guildId: SCAN.guildId,
        status: { in: ['ACTIVE', 'EXPIRED'] },
      },
      select: {
        id: true,
        guildId: true,
        alias: true,
        alias5: true,
        status: true,
        encryptedToken: true,
      },
    });
    expect(decrypt).toHaveBeenCalledWith('fresh-cipher', 'test-encryption-key');
    expect(decrypt).not.toHaveBeenCalledWith('scan-old-cipher', expect.anything());
    expect(validateTokenDetailed).toHaveBeenCalledTimes(1);
    expect(markValidated).toHaveBeenCalledWith(SCAN.guildId, SCAN.id);
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });

  it('no-ops safely when the connection disappeared between scan and lock', async () => {
    findFirst.mockResolvedValue(null);

    await validateConnectionTokenOnce(discord, SCAN);

    expect(decrypt).not.toHaveBeenCalled();
    expect(validateTokenDetailed).not.toHaveBeenCalled();
    expect(recordValidationFailure).not.toHaveBeenCalled();
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });

  it('does not count a fresh-snapshot database read failure as token failure', async () => {
    findFirst.mockRejectedValue(new Error('db read failed'));

    await validateConnectionTokenOnce(discord, SCAN);

    expect(recordValidationFailure).not.toHaveBeenCalled();
    expect(decrypt).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Token-Validation-Snapshot'));
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });

  it('marks only the locked fresh ACTIVE snapshot expired after a proven INVALID result', async () => {
    validateTokenDetailed.mockResolvedValue({ kind: 'INVALID', status: 401 });

    await validateConnectionTokenOnce(discord, SCAN);

    expect(recordValidationFailure).toHaveBeenCalledWith(
      SCAN.guildId,
      SCAN.id,
      'INVALID status=401',
    );
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: SCAN.id, guildId: SCAN.guildId },
      data: { lastErrorMessage: 'safe' },
    });
    expect(setStatus).toHaveBeenCalledWith(SCAN.guildId, SCAN.id, 'EXPIRED');
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });

  it('releases the connection lock even when an unexpected post-validation write fails', async () => {
    markValidated.mockRejectedValue(new Error('status write failed'));

    await validateConnectionTokenOnce(discord, SCAN);

    expect(recordValidationFailure).toHaveBeenCalledWith(
      SCAN.guildId,
      SCAN.id,
      'UNEXPECTED_VALIDATION_ERROR: status write failed',
    );
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });
});
