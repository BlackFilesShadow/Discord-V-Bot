/**
 * Phase 4/5: strukturierte Ledger-Saetze fuer deposit/withdraw/transferBank.
 * Beweis:
 * - jeder Geldpfad traegt guildId + nitradoConnId + userDiscordId,
 * - korrekte wallet/bankDelta,
 * - bei fehlender Deckung entsteht KEIN Ledger-Satz.
 */
const mockExecuteRaw = jest.fn<Promise<number>, [string, ...unknown[]]>();
const mockQueryRaw = jest.fn<Promise<unknown[]>, [string, ...unknown[]]>();
const mockAssertEconomyScopeReady = jest.fn<Promise<void>, [unknown, unknown]>();

jest.mock('../../src/modules/economy/scopeMigration', () => ({
  assertEconomyScopeReady: mockAssertEconomyScopeReady,
}));

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({
      $executeRawUnsafe: mockExecuteRaw,
      $queryRawUnsafe: mockQueryRaw,
    }),
    $executeRawUnsafe: mockExecuteRaw,
    $queryRawUnsafe: mockQueryRaw,
  },
}));

import { deposit, withdraw, transferBank } from '../../src/modules/economy/repository';
import { asGuildId, asNitradoConnId, asUserDiscordId } from '../../src/types/scope';

const G = asGuildId('123456789012345678');
const C = asNitradoConnId('clx1234567890123456789012');
const U = asUserDiscordId('234567890123456789');
const U2 = asUserDiscordId('345678901234567890');

function callsFor(table: string): Array<[string, ...unknown[]]> {
  return mockExecuteRaw.mock.calls.filter(([sql]) => sql.includes(`\"${table}\"`));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAssertEconomyScopeReady.mockResolvedValue(undefined);
  mockExecuteRaw.mockResolvedValue(1);
  mockQueryRaw.mockResolvedValue([{
    id: 'acct-target', guildId: String(G), nitradoConnId: String(C), userDiscordId: String(U2),
    walletBalance: 0n, bankBalance: 0n, lifetimeEarned: 0n, lifetimeSpent: 0n,
  }]);
});

describe('deposit — servergescopter strukturierter Ledger', () => {
  it('bindet Guild+Server+User und schreibt walletDelta=-amount, bankDelta=+amount', async () => {
    await deposit(G, C, U, 100n);

    expect(mockAssertEconomyScopeReady).toHaveBeenCalledWith(G, C);
    const accountUpdate = callsFor('EconomyAccount')[0];
    expect(accountUpdate.slice(1, 5)).toEqual([String(G), String(C), String(U), 100n]);

    const ledger = callsFor('EconomyLedgerEntry');
    expect(ledger).toHaveLength(1);
    const params = ledger[0].slice(1);
    expect(params[2]).toBe(String(G));
    expect(params[3]).toBe(String(C));
    expect(params[4]).toBe(String(U));
    expect(params[5]).toBe(-100n);
    expect(params[6]).toBe(100n);
    expect(params[7]).toBe('DEPOSIT');
  });

  it('ohne Deckung -> Fehler, KEIN Ledger-Satz', async () => {
    mockExecuteRaw.mockImplementation(async (sql) => sql.startsWith('UPDATE "EconomyAccount"') ? 0 : 1);
    await expect(deposit(G, C, U, 100n)).rejects.toThrow('Wallet zu klein');
    expect(callsFor('EconomyLedgerEntry')).toHaveLength(0);
  });
});

describe('withdraw — servergescopter strukturierter Ledger', () => {
  it('bindet Guild+Server+User und schreibt bankDelta=-amount, walletDelta=+amount', async () => {
    await withdraw(G, C, U, 40n);

    const accountUpdate = callsFor('EconomyAccount')[0];
    expect(accountUpdate.slice(1, 5)).toEqual([String(G), String(C), String(U), 40n]);

    const ledger = callsFor('EconomyLedgerEntry');
    expect(ledger).toHaveLength(1);
    const params = ledger[0].slice(1);
    expect(params[2]).toBe(String(G));
    expect(params[3]).toBe(String(C));
    expect(params[4]).toBe(String(U));
    expect(params[5]).toBe(40n);
    expect(params[6]).toBe(-40n);
    expect(params[7]).toBe('WITHDRAW');
  });

  it('ohne Deckung -> Fehler, KEIN Ledger-Satz', async () => {
    mockExecuteRaw.mockImplementation(async (sql) => sql.startsWith('UPDATE "EconomyAccount"') ? 0 : 1);
    await expect(withdraw(G, C, U, 40n)).rejects.toThrow('Bank zu klein');
    expect(callsFor('EconomyLedgerEntry')).toHaveLength(0);
  });
});

describe('transferBank — konstruktiv kein Cross-Server-Transfer', () => {
  it('schreibt beide Ledger-Saetze im selben nitradoConnId', async () => {
    await transferBank({ guildId: G, nitradoConnId: C, fromUserId: U, toUserId: U2, amount: 250n });

    expect(mockAssertEconomyScopeReady).toHaveBeenCalledWith(G, C);
    const ledger = callsFor('EconomyLedgerEntry');
    expect(ledger).toHaveLength(2);

    const from = ledger[0].slice(1);
    const to = ledger[1].slice(1);
    expect(from[2]).toBe(String(G));
    expect(from[3]).toBe(String(C));
    expect(from[4]).toBe(String(U));
    expect(from[6]).toBe(-250n);
    expect(to[2]).toBe(String(G));
    expect(to[3]).toBe(String(C));
    expect(to[4]).toBe(String(U2));
    expect(to[6]).toBe(250n);
  });

  it('ohne Deckung -> Fehler, KEIN Ledger-Satz', async () => {
    mockExecuteRaw.mockImplementation(async (sql) => sql.startsWith('UPDATE "EconomyAccount"') ? 0 : 1);
    await expect(transferBank({
      guildId: G, nitradoConnId: C, fromUserId: U, toUserId: U2, amount: 250n,
    })).rejects.toThrow('Bank zu klein');
    expect(callsFor('EconomyLedgerEntry')).toHaveLength(0);
  });
});
