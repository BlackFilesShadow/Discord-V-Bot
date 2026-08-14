process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

const migrationFindUnique = jest.fn();
const migrationUpdate = jest.fn(async () => ({}));
const connectionFindFirst = jest.fn();
const executeRawUnsafe = jest.fn(async (..._args: unknown[]) => 1);
const transaction = jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({
  $executeRawUnsafe: executeRawUnsafe,
  economyScopeMigration: { update: migrationUpdate },
}));

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    economyScopeMigration: { findUnique: migrationFindUnique },
    nitradoConnection: { findFirst: connectionFindFirst },
    $transaction: transaction,
  },
}));

jest.mock('../../src/utils/logger', () => ({
  logAudit: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  EconomyMigrationRequiredError,
  EconomyScopeMismatchError,
  assertEconomyScopeReady,
  resolveLegacyEconomyPrimaryServer,
} from '../../src/modules/economy/scopeMigration';
import { asGuildId, asNitradoConnId, asUserDiscordId } from '../../src/types/scope';

const guildId = asGuildId('123456789012345678');
const connA = asNitradoConnId('clx1234567890123456789012');
const connB = asNitradoConnId('clx2234567890123456789012');
const actor = asUserDiscordId('234567890123456789');

beforeEach(() => {
  jest.clearAllMocks();
  executeRawUnsafe.mockResolvedValue(1);
  transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn({
    $executeRawUnsafe: executeRawUnsafe,
    economyScopeMigration: { update: migrationUpdate },
  }));
});

describe('ECO-S03 Legacy-Economy Scope Migration', () => {
  it('laesst Guilds ohne Legacy-Migrationszustand passieren', async () => {
    migrationFindUnique.mockResolvedValue(null);
    await expect(assertEconomyScopeReady(guildId, connA)).resolves.toBeUndefined();
  });

  it('blockiert MIGRATION_REQUIRED fail-closed', async () => {
    migrationFindUnique.mockResolvedValue({
      guildId,
      status: 'MIGRATION_REQUIRED',
      primaryNitradoConnId: null,
      detectedActiveServerCount: 2,
      resolvedByDiscordId: null,
      resolvedAt: null,
    });
    await expect(assertEconomyScopeReady(guildId, connA)).rejects.toBeInstanceOf(EconomyMigrationRequiredError);
  });

  it('blockiert Zugriff ueber einen anderen als den Legacy-Primaerserver', async () => {
    migrationFindUnique.mockResolvedValue({
      guildId,
      status: 'RESOLVED',
      primaryNitradoConnId: connA,
      detectedActiveServerCount: 2,
      resolvedByDiscordId: actor,
      resolvedAt: new Date(),
    });
    await expect(assertEconomyScopeReady(guildId, connB)).rejects.toBeInstanceOf(EconomyScopeMismatchError);
  });

  it('verweigert eine Owner-Aufloesung auf einen fremden/inaktiven Slot', async () => {
    connectionFindFirst.mockResolvedValue(null);
    await expect(resolveLegacyEconomyPrimaryServer({
      guildId,
      primaryNitradoConnId: connA,
      actorDiscordId: actor,
    })).rejects.toThrow(/nicht als aktiver Gameserver nutzbar/);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('ist bei erneuter Auswahl desselben bereits aufgeloesten Servers idempotent', async () => {
    connectionFindFirst.mockResolvedValue({ id: connA });
    migrationFindUnique.mockResolvedValue({
      guildId,
      status: 'RESOLVED',
      primaryNitradoConnId: connA,
      detectedActiveServerCount: 2,
      resolvedByDiscordId: actor,
      resolvedAt: new Date(),
    });

    await expect(resolveLegacyEconomyPrimaryServer({
      guildId,
      primaryNitradoConnId: connA,
      actorDiscordId: actor,
    })).resolves.toEqual({ alreadyResolved: true, primaryNitradoConnId: connA, updatedRows: 0 });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('verweigert stilles Umschwenken einer bereits aufgeloesten Legacy-Economy', async () => {
    connectionFindFirst.mockResolvedValue({ id: connB });
    migrationFindUnique.mockResolvedValue({
      guildId,
      status: 'RESOLVED',
      primaryNitradoConnId: connA,
      detectedActiveServerCount: 2,
      resolvedByDiscordId: actor,
      resolvedAt: new Date(),
    });

    await expect(resolveLegacyEconomyPrimaryServer({
      guildId,
      primaryNitradoConnId: connB,
      actorDiscordId: actor,
    })).rejects.toBeInstanceOf(EconomyScopeMismatchError);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('ordnet nur bestehende Legacy-Zeilen zu und erzeugt keine Guthaben-Kopien', async () => {
    connectionFindFirst.mockResolvedValue({ id: connA });
    migrationFindUnique.mockResolvedValue({
      guildId,
      status: 'MIGRATION_REQUIRED',
      primaryNitradoConnId: null,
      detectedActiveServerCount: 2,
      resolvedByDiscordId: null,
      resolvedAt: null,
    });

    const result = await resolveLegacyEconomyPrimaryServer({
      guildId,
      primaryNitradoConnId: connA,
      actorDiscordId: actor,
    });

    expect(result.alreadyResolved).toBe(false);
    expect(result.primaryNitradoConnId).toBe(connA);
    expect(result.updatedRows).toBe(8);
    expect(executeRawUnsafe).toHaveBeenCalledTimes(8);
    const rawCalls = executeRawUnsafe.mock.calls as unknown as Array<[string, ...unknown[]]>;
    for (const [sql] of rawCalls) {
      expect(String(sql)).toMatch(/^UPDATE /);
      expect(String(sql)).not.toMatch(/\bINSERT\b|\bCOPY\b/i);
    }
    expect(migrationUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { guildId },
      data: expect.objectContaining({
        status: 'RESOLVED',
        primaryNitradoConnId: connA,
        resolvedByDiscordId: actor,
      }),
    }));
  });
});
