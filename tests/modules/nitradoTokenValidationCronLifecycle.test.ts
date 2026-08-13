process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    nitradoConnection: { findMany: jest.fn(async () => []) },
  },
}));
jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
}));
jest.mock('../../src/utils/security', () => ({ decrypt: jest.fn(() => 'token-1234') }));
jest.mock('../../src/modules/nitrado/repository', () => ({
  setStatus: jest.fn(),
  markValidated: jest.fn(),
}));
jest.mock('../../src/modules/nitrado/nitradoClient', () => ({
  NitradoClient: jest.fn().mockImplementation(() => ({ validateTokenDetailed: jest.fn(async () => ({ kind: 'VALID' })) })),
}));

import type { Client } from 'discord.js';
import { startTokenValidationCron, stopTokenValidationCron } from '../../src/modules/nitrado/tokenValidationCron';

const discord = { guilds: { cache: new Map() } } as unknown as Client;

describe('Token validation cron lifecycle', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    stopTokenValidationCron();
  });

  afterEach(() => {
    stopTokenValidationCron();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('startet genau Initial-Timeout plus Intervall und stoppt beide Handles', () => {
    startTokenValidationCron(discord);
    expect(jest.getTimerCount()).toBe(2);

    // Mehrfachstart darf keine zusaetzlichen Handles erzeugen.
    startTokenValidationCron(discord);
    expect(jest.getTimerCount()).toBe(2);

    stopTokenValidationCron();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('kann nach einem Stop sauber neu gestartet werden', () => {
    startTokenValidationCron(discord);
    stopTokenValidationCron();
    startTokenValidationCron(discord);
    expect(jest.getTimerCount()).toBe(2);
  });
});
