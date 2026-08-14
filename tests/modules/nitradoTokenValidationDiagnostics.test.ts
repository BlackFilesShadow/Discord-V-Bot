process.env.NODE_ENV = 'test';
process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';
process.env.DASHBOARD_URL ||= 'http://localhost:3000';

const connectionUpdateMany = jest.fn(async () => ({ count: 1 }));
jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    nitradoConnection: {
      updateMany: connectionUpdateMany,
      findMany: jest.fn(async () => []),
    },
  },
}));

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
}));

const decryptMock = jest.fn(() => 'token-1234');
jest.mock('../../src/utils/security', () => ({
  decrypt: (...args: unknown[]) => decryptMock(...args),
}));

const setStatus = jest.fn(async () => undefined);
const markValidated = jest.fn(async () => undefined);
jest.mock('../../src/modules/nitrado/repository', () => ({ setStatus, markValidated }));

const recordValidationFailure = jest.fn();
jest.mock('../../src/modules/nitrado/validationHealth', () => {
  const actual = jest.requireActual('../../src/modules/nitrado/validationHealth');
  return {
    ...actual,
    recordValidationFailure,
  };
});

const validateTokenDetailed = jest.fn();
jest.mock('../../src/modules/nitrado/nitradoClient', () => ({
  NitradoClient: jest.fn().mockImplementation(() => ({ validateTokenDetailed })),
}));

import type { Client } from 'discord.js';
import { validateConnectionTokenOnce } from '../../src/modules/nitrado/tokenValidationCron';

const send = jest.fn(async () => undefined);
const owner = { send };
const guild = {
  name: 'Test Guild',
  fetchOwner: jest.fn(async () => owner),
};
const discord = {
  guilds: { cache: new Map([['guild-1', guild]]) },
} as unknown as Client;

const conn = {
  id: 'conn-1',
  guildId: 'guild-1',
  alias: 'Main',
  alias5: 'ABCDE',
  status: 'ACTIVE',
  encryptedToken: 'ciphertext',
};

beforeEach(() => {
  jest.clearAllMocks();
  decryptMock.mockReturnValue('token-1234');
  recordValidationFailure.mockResolvedValue({
    failureCount: 1,
    shouldAlert: false,
    safeMessage: 'temporary',
  });
});

describe('NIT-001 token validation diagnostics', () => {
  it('VALID reaktiviert/resettet und erzeugt keinen Fehlerstreak', async () => {
    validateTokenDetailed.mockResolvedValue({ kind: 'VALID' });

    await validateConnectionTokenOnce(discord, { ...conn, status: 'EXPIRED' });

    expect(markValidated).toHaveBeenCalledTimes(1);
    expect(recordValidationFailure).not.toHaveBeenCalled();
    expect(setStatus).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('transienter Fehler bleibt ACTIVE und warnt vor Schwelle nicht', async () => {
    validateTokenDetailed.mockResolvedValue({ kind: 'TRANSIENT_FAILURE', status: 503, message: 'temporary outage' });
    recordValidationFailure.mockResolvedValue({
      failureCount: 2,
      shouldAlert: false,
      safeMessage: 'TRANSIENT_FAILURE status=503 message=temporary outage',
    });

    await validateConnectionTokenOnce(discord, conn);

    expect(recordValidationFailure).toHaveBeenCalledTimes(1);
    expect(connectionUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: conn.id, guildId: conn.guildId },
    }));
    expect(setStatus).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('dritter transienter Fehler sendet genau eine generische Owner-Warnung', async () => {
    validateTokenDetailed.mockResolvedValue({ kind: 'RATE_LIMITED' });
    recordValidationFailure.mockResolvedValue({
      failureCount: 3,
      shouldAlert: true,
      safeMessage: 'RATE_LIMITED',
    });

    await validateConnectionTokenOnce(discord, conn);

    expect(setStatus).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
    expect(String(send.mock.calls[0]?.[0])).toContain('3 Mal in Folge');
    expect(String(send.mock.calls[0]?.[0])).toContain('nicht automatisch als abgelaufen');
  });

  it('INVALID markiert nur ACTIVE als EXPIRED und nutzt die spezifische Ablauf-DM', async () => {
    validateTokenDetailed.mockResolvedValue({ kind: 'INVALID', status: 401 });
    // Selbst wenn der DB-Claim true waere, INVALID darf keinen zusaetzlichen
    // generischen Wiederholungs-Alert senden.
    recordValidationFailure.mockResolvedValue({
      failureCount: 3,
      shouldAlert: true,
      safeMessage: 'INVALID status=401',
    });

    await validateConnectionTokenOnce(discord, conn);

    expect(setStatus).toHaveBeenCalledWith('guild-1', 'conn-1', 'EXPIRED');
    expect(send).toHaveBeenCalledTimes(1);
    expect(String(send.mock.calls[0]?.[0])).toContain('abgelaufen');
  });

  it('bereits EXPIRED erzeugt bei erneut INVALID keine weitere Ablauf-DM', async () => {
    validateTokenDetailed.mockResolvedValue({ kind: 'INVALID', status: 401 });

    await validateConnectionTokenOnce(discord, { ...conn, status: 'EXPIRED' });

    expect(recordValidationFailure).toHaveBeenCalledTimes(1);
    expect(setStatus).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('Decrypt-Fehler wird persistent gezaehlt und kann den Wiederholungs-Alert ausloesen', async () => {
    decryptMock.mockImplementation(() => { throw new Error('bad key token=super-secret'); });
    recordValidationFailure.mockResolvedValue({
      failureCount: 3,
      shouldAlert: true,
      safeMessage: 'DECRYPT_FAILED: bad key token=[REDACTED]',
    });

    await validateConnectionTokenOnce(discord, conn);

    expect(validateTokenDetailed).not.toHaveBeenCalled();
    expect(recordValidationFailure).toHaveBeenCalledTimes(1);
    expect(setStatus).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('geworfener API-Fehler bleibt transient und wird diagnostiziert', async () => {
    validateTokenDetailed.mockRejectedValue(new Error('socket reset'));
    recordValidationFailure.mockResolvedValue({
      failureCount: 1,
      shouldAlert: false,
      safeMessage: 'VALIDATION_EXCEPTION: socket reset',
    });

    await validateConnectionTokenOnce(discord, conn);

    expect(recordValidationFailure).toHaveBeenCalledTimes(1);
    expect(setStatus).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});
