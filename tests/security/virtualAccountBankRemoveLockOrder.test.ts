const mockRootQuery = jest.fn();
const mockRootExecute = jest.fn();
const mockTransaction = jest.fn();
const mockTxQuery = jest.fn();
const mockTxExecute = jest.fn();
const mockAssertEconomyScopeReady = jest.fn();
const mockGetVirtualAccountById = jest.fn();

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    $queryRawUnsafe: mockRootQuery,
    $executeRawUnsafe: mockRootExecute,
    $transaction: mockTransaction,
  },
}));

jest.mock('../../src/modules/economy/scopeMigration', () => ({
  assertEconomyScopeReady: mockAssertEconomyScopeReady,
}));

jest.mock('../../src/modules/economy/virtualAccounts', () => ({
  createVirtualAccount: jest.fn(),
  getVirtualAccountById: mockGetVirtualAccountById,
}));

jest.mock('../../src/modules/economy/repository', () => ({
  getConfig: jest.fn(),
}));

import { removeVirtualAccountAmount } from '../../src/modules/economy/virtualAccountFinance';

const finance = {
  accountId: 'acct-1',
  guildId: 'guild-1',
  nitradoConnId: 'conn-1',
  bankBalance: 100n,
  currencyName: 'Coins',
  currencyEmoji: '🪙',
  accountEmoji: '🏦',
  bannerUrl: null,
  textStyle: 'NORMAL',
  exchangePlayerUnits: null,
  exchangeAccountUnits: null,
  accountPurpose: 'GENERAL',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

const account = {
  id: 'acct-1',
  guildId: 'guild-1',
  nitradoConnId: 'conn-1',
  kind: 'CUSTOM',
  name: 'Testkonto',
  nameKey: 'testkonto',
  balance: 10n,
  status: 'ACTIVE',
  acceptUserTransfers: true,
  expiresAt: null,
  archivedAt: null,
  archivedByDiscordId: null,
  createdByDiscordId: 'admin-1',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

describe('virtual account BANK remove lock order', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAssertEconomyScopeReady.mockResolvedValue(undefined);
    mockRootQuery.mockResolvedValue([finance]);
    mockGetVirtualAccountById.mockResolvedValue(account);
    mockTxQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('EconomyVirtualAccountEntry')) return [];
      if (sql.includes('EconomyVirtualAccount') && sql.includes('FOR UPDATE')) return [{ id: 'acct-1' }];
      return [];
    });
    mockTxExecute.mockResolvedValue(1);
    mockTransaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => callback({
      $queryRawUnsafe: mockTxQuery,
      $executeRawUnsafe: mockTxExecute,
    }));
  });

  it('locks the base account before touching the finance row or inserting the manager ledger entry', async () => {
    await expect(removeVirtualAccountAmount({
      idempotencyKey: 'interaction-1',
      guildId: 'guild-1' as any,
      nitradoConnId: 'conn-1' as any,
      accountId: 'acct-1',
      actorDiscordId: '12345678901234567' as any,
      pocket: 'BANK',
      amount: 5n,
      reason: 'Bankkorrektur Test',
    })).resolves.toMatchObject({ booked: true });

    const accountLockCall = mockTxQuery.mock.calls.findIndex(call =>
      String(call[0]).includes('FROM "EconomyVirtualAccount"') && String(call[0]).includes('FOR UPDATE'),
    );
    const financeUpdateCall = mockTxExecute.mock.calls.findIndex(call =>
      String(call[0]).startsWith('UPDATE "EconomyVirtualAccountFinance"'),
    );
    const ledgerInsertCall = mockTxExecute.mock.calls.findIndex(call =>
      String(call[0]).startsWith('INSERT INTO "EconomyVirtualAccountEntry"'),
    );

    expect(accountLockCall).toBeGreaterThan(-1);
    expect(financeUpdateCall).toBeGreaterThan(-1);
    expect(ledgerInsertCall).toBeGreaterThan(-1);

    const accountLockOrder = mockTxQuery.mock.invocationCallOrder[accountLockCall];
    const financeUpdateOrder = mockTxExecute.mock.invocationCallOrder[financeUpdateCall];
    const ledgerInsertOrder = mockTxExecute.mock.invocationCallOrder[ledgerInsertCall];

    expect(accountLockOrder).toBeLessThan(financeUpdateOrder);
    expect(financeUpdateOrder).toBeLessThan(ledgerInsertOrder);
  });
});
