const mockExecuteRaw = jest.fn();
const mockQueryRaw = jest.fn();
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

import {
  archiveVirtualAccount,
  createVirtualAccount,
  normalizeVirtualAccountName,
  transferUserToVirtualAccount,
  transferVirtualAccountToUser,
} from '../../src/modules/economy/virtualAccounts';
import { asGuildId, asNitradoConnId, asUserDiscordId } from '../../src/types/scope';

const G = asGuildId('123456789012345678');
const C = asNitradoConnId('clx1234567890123456789012');
const U = asUserDiscordId('234567890123456789');
const U2 = asUserDiscordId('345678901234567890');

function baseAccount(balance = 500n) {
  return {
    id: 'virtual-1', guildId: String(G), nitradoConnId: String(C), kind: 'CUSTOM',
    name: 'Eventkasse', nameKey: 'eventkasse', balance, status: 'ACTIVE',
    acceptUserTransfers: true, expiresAt: null, archivedAt: null, archivedByDiscordId: null,
    createdByDiscordId: String(U), createdAt: new Date('2026-08-16T10:00:00Z'), updatedAt: new Date('2026-08-16T10:00:00Z'),
  };
}

function sqlCalls(fragment: string) {
  return mockExecuteRaw.mock.calls.filter(([sql]) => String(sql).includes(fragment));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAssertEconomyScopeReady.mockResolvedValue(undefined);
  mockExecuteRaw.mockResolvedValue(1);
  mockQueryRaw.mockImplementation(async (sql: string, ...values: unknown[]) => {
    if (sql.startsWith('INSERT INTO "EconomyVirtualAccount"')) return [baseAccount(0n)];
    if (sql.startsWith('UPDATE "EconomyVirtualAccount"') && sql.includes('RETURNING')) {
      const amount = typeof values[3] === 'bigint' ? values[3] as bigint : 0n;
      if (sql.includes('"balance"="balance"+$4')) return [{ ...baseAccount(500n + amount), balance: 500n + amount }];
      if (sql.includes('"balance"="balance"-$4')) return [{ ...baseAccount(500n - amount), balance: 500n - amount }];
      return [{ ...baseAccount(0n), status: 'ARCHIVED', archivedAt: new Date() }];
    }
    if (sql.includes('FROM "EconomyVirtualAccount"')) return [baseAccount()];
    return [];
  });
});

describe('virtual account names and creation', () => {
  it('normalisiert Namen deterministisch fuer serverlokale Eindeutigkeit', () => {
    expect(normalizeVirtualAccountName('  Event   Kasse  ')).toEqual({ name: 'Event Kasse', nameKey: 'event kasse' });
    expect(() => normalizeVirtualAccountName('\nkaputt')).toThrow();
  });

  it('bindet die Erstellung strikt an Guild + Gameserver', async () => {
    await createVirtualAccount({
      guildId: G, nitradoConnId: C, name: 'Eventkasse', createdByDiscordId: U,
      acceptUserTransfers: true,
    });
    expect(mockAssertEconomyScopeReady).toHaveBeenCalledWith(G, C);
    const insert = mockQueryRaw.mock.calls.find(([sql]) => String(sql).startsWith('INSERT INTO "EconomyVirtualAccount"'))!;
    expect(insert[2]).toBe(String(G));
    expect(insert[3]).toBe(String(C));
    expect(insert[5]).toBe('Eventkasse');
    expect(insert[6]).toBe('eventkasse');
  });
});

describe('User -> virtuelles Konto', () => {
  it('bucht atomar, servergescoppt und mit strukturiertem User-Ledger', async () => {
    const result = await transferUserToVirtualAccount({
      idempotencyKey: 'discord-virtual-pay:abc', guildId: G, nitradoConnId: C,
      fromUserId: U, virtualAccountId: 'virtual-1', amount: 75n, sourcePocket: 'BANK', reason: 'Event',
    });
    expect(result.booked).toBe(true);
    expect(mockAssertEconomyScopeReady).toHaveBeenCalledWith(G, C);

    const debit = sqlCalls('UPDATE "EconomyAccount"').find(([sql]) => String(sql).includes('"bankBalance"="bankBalance"-$4'))!;
    expect(debit.slice(1, 5)).toEqual([String(G), String(C), String(U), 75n]);

    const entry = sqlCalls('INSERT INTO "EconomyVirtualAccountEntry"')[0];
    expect(entry[2]).toBe('discord-virtual-pay:abc');
    expect(entry[3]).toBe(String(G));
    expect(entry[4]).toBe(String(C));
    expect(entry[5]).toBe('virtual-1');
    expect(entry[6]).toBe(75n);

    const ledger = sqlCalls('INSERT INTO "EconomyLedgerEntry"')[0];
    expect(ledger[2]).toBe('discord-virtual-pay:abc:user');
    expect(ledger[3]).toBe(String(G));
    expect(ledger[4]).toBe(String(C));
    expect(ledger[5]).toBe(String(U));
    expect(ledger[7]).toBe(-75n);
  });

  it('behandelt denselben Idempotency-Key als No-op und bucht nicht doppelt', async () => {
    mockExecuteRaw.mockImplementation(async (sql: string) => sql.startsWith('INSERT INTO "EconomyVirtualAccountEntry"') ? 0 : 1);
    const result = await transferUserToVirtualAccount({
      idempotencyKey: 'same-op', guildId: G, nitradoConnId: C,
      fromUserId: U, virtualAccountId: 'virtual-1', amount: 10n, sourcePocket: 'WALLET',
    });
    expect(result.booked).toBe(false);
    expect(sqlCalls('UPDATE "EconomyAccount"').filter(([sql]) => String(sql).includes('-$4'))).toHaveLength(0);
    expect(sqlCalls('INSERT INTO "EconomyLedgerEntry"')).toHaveLength(0);
  });

  it('bricht bei fehlender Deckung vor User-Ledger und virtueller Gutschrift ab', async () => {
    mockExecuteRaw.mockImplementation(async (sql: string) => {
      if (sql.startsWith('UPDATE "EconomyAccount"') && sql.includes('-$4')) return 0;
      return 1;
    });
    await expect(transferUserToVirtualAccount({
      idempotencyKey: 'no-money', guildId: G, nitradoConnId: C,
      fromUserId: U, virtualAccountId: 'virtual-1', amount: 999n, sourcePocket: 'WALLET',
    })).rejects.toThrow('Wallet zu klein');
    expect(mockQueryRaw.mock.calls.filter(([sql]) => String(sql).includes('"balance"="balance"+$4'))).toHaveLength(0);
    expect(sqlCalls('INSERT INTO "EconomyLedgerEntry"')).toHaveLength(0);
  });
});

describe('virtuelles Konto -> User und Archivierung', () => {
  it('zahlt innerhalb desselben Gameservers aus und erzeugt keine Cross-Server-Buchung', async () => {
    const result = await transferVirtualAccountToUser({
      idempotencyKey: 'refund:1', guildId: G, nitradoConnId: C,
      virtualAccountId: 'virtual-1', toUserId: U2, amount: 120n, targetPocket: 'WALLET',
      actorDiscordId: U, reason: 'Refund', entryType: 'REFUND',
    });
    expect(result.booked).toBe(true);
    const credit = sqlCalls('UPDATE "EconomyAccount"').find(([sql]) => String(sql).includes('"walletBalance"="walletBalance"+$4'))!;
    expect(credit.slice(1, 5)).toEqual([String(G), String(C), String(U2), 120n]);
    const ledger = sqlCalls('INSERT INTO "EconomyLedgerEntry"')[0];
    expect(ledger[3]).toBe(String(G));
    expect(ledger[4]).toBe(String(C));
    expect(ledger[5]).toBe(String(U2));
    expect(ledger[6]).toBe(120n);
  });

  it('verweigert Archivierung bei offenem Guthaben', async () => {
    await expect(archiveVirtualAccount({
      guildId: G, nitradoConnId: C, accountId: 'virtual-1', actorDiscordId: U,
    })).rejects.toThrow('noch Guthaben');
    expect(mockQueryRaw.mock.calls.filter(([sql]) => String(sql).startsWith('UPDATE "EconomyVirtualAccount"') && String(sql).includes('ARCHIVED'))).toHaveLength(0);
  });

  it('archiviert ein leeres Konto unter Row-Lock', async () => {
    mockQueryRaw.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM "EconomyVirtualAccount"')) return [baseAccount(0n)];
      if (sql.startsWith('UPDATE "EconomyVirtualAccount"') && sql.includes('ARCHIVED')) return [{ ...baseAccount(0n), status: 'ARCHIVED', archivedAt: new Date() }];
      return [];
    });
    const result = await archiveVirtualAccount({ guildId: G, nitradoConnId: C, accountId: 'virtual-1', actorDiscordId: U });
    expect(result.status).toBe('ARCHIVED');
    const lockRead = mockQueryRaw.mock.calls.find(([sql]) => String(sql).includes('FOR UPDATE'))!;
    expect(lockRead[2]).toBe(String(G));
    expect(lockRead[3]).toBe(String(C));
  });
});
