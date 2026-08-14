/**
 * Phase 4/5: GET erzeugt keinen Account. getAccountOrZero liest nur — fehlt der
 * Account, kommt ein Null-Konto OHNE DB-Write zurueck. Der Read muss dabei
 * zwingend guildId + nitradoConnId + userDiscordId tragen.
 */
const mockQueryRaw = jest.fn<Promise<unknown[]>, [string, ...unknown[]]>();
const mockExecuteRaw = jest.fn<Promise<number>, [string, ...unknown[]]>();
const mockAssertEconomyScopeReady = jest.fn<Promise<void>, [unknown, unknown]>();

jest.mock('../../src/modules/economy/scopeMigration', () => ({
  assertEconomyScopeReady: mockAssertEconomyScopeReady,
}));

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    $queryRawUnsafe: mockQueryRaw,
    $executeRawUnsafe: mockExecuteRaw,
  },
}));

import { getAccountOrZero } from '../../src/modules/economy/repository';
import { asGuildId, asNitradoConnId, asUserDiscordId } from '../../src/types/scope';

const G = asGuildId('123456789012345678');
const C = asNitradoConnId('clx1234567890123456789012');
const U = asUserDiscordId('234567890123456789');

beforeEach(() => {
  jest.clearAllMocks();
  mockAssertEconomyScopeReady.mockResolvedValue(undefined);
});

describe('getAccountOrZero', () => {
  it('liefert Null-Konto ohne DB-Write, wenn im ausgewaehlten Server kein Account existiert', async () => {
    mockQueryRaw.mockResolvedValue([]);
    const acc = await getAccountOrZero(G, C, U);

    expect(acc.guildId).toBe(G);
    expect(acc.nitradoConnId).toBe(C);
    expect(acc.userDiscordId).toBe(U);
    expect(acc.walletBalance).toBe(0n);
    expect(acc.bankBalance).toBe(0n);
    expect(acc.lifetimeEarned).toBe(0n);
    expect(mockExecuteRaw).not.toHaveBeenCalled();
    expect(mockAssertEconomyScopeReady).toHaveBeenCalledWith(G, C);

    expect(mockQueryRaw).toHaveBeenCalledTimes(1);
    const [sql, guildParam, connParam, userParam] = mockQueryRaw.mock.calls[0];
    expect(sql).toContain('FROM "EconomyAccount"');
    expect(sql).toContain('"nitradoConnId" = $2');
    expect([guildParam, connParam, userParam]).toEqual([String(G), String(C), String(U)]);
  });

  it('liefert nur das bestehende Konto desselben Gameserver-Scopes', async () => {
    mockQueryRaw.mockResolvedValue([{
      id: 'acct-1',
      guildId: String(G),
      nitradoConnId: String(C),
      userDiscordId: String(U),
      walletBalance: 500n,
      bankBalance: 200n,
      lifetimeEarned: 700n,
      lifetimeSpent: 0n,
    }]);

    const acc = await getAccountOrZero(G, C, U);
    expect(acc.nitradoConnId).toBe(C);
    expect(acc.walletBalance).toBe(500n);
    expect(acc.bankBalance).toBe(200n);
    expect(mockExecuteRaw).not.toHaveBeenCalled();
  });
});
