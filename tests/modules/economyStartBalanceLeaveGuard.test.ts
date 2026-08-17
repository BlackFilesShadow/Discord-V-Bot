const queryRaw = jest.fn();
const executeRaw = jest.fn();
const txExecuteRaw = jest.fn();
const transaction = jest.fn();
const completedLeaveReceipt = jest.fn();
const scopeReady = jest.fn();

jest.mock('../../src/config', () => ({
  config: { security: { encryptionKey: '0123456789abcdef0123456789abcdef' } },
}));

jest.mock('../../src/modules/moderation/leaveCleanupSaga', () => ({
  hasCompletedLeaveCleanupReceipt: completedLeaveReceipt,
}));

jest.mock('../../src/modules/economy/scopeMigration', () => ({
  assertEconomyScopeReady: scopeReady,
}));

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    $queryRawUnsafe: queryRaw,
    $executeRawUnsafe: executeRaw,
    $transaction: transaction,
  },
}));

import { maybeGrantStartBalance } from '../../src/modules/economy/repository';

const GUILD = '12345678901234567' as never;
const CONN = 'conn-1' as never;
const USER = '22345678901234567' as never;

beforeEach(() => {
  jest.clearAllMocks();
  scopeReady.mockResolvedValue(undefined);
  queryRaw.mockResolvedValue([{
    guildId: GUILD,
    nitradoConnId: CONN,
    enabled: true,
    currencyName: 'Coins',
    emoji: 'x',
    startBalance: 5000,
    playtimeRewardPercent: 0,
    bankInterestPercent: 0,
    bankChannelId: null,
  }]);
  completedLeaveReceipt.mockResolvedValue(false);
  txExecuteRaw.mockResolvedValue(1);
  transaction.mockImplementation(async (fn: (tx: { $executeRawUnsafe: typeof txExecuteRaw }) => unknown) => fn({ $executeRawUnsafe: txExecuteRaw }));
});

describe('legacy maybeGrantStartBalance Leave guard', () => {
  it('blocks rejoin start balance before account or ledger creation when a completed leave receipt exists', async () => {
    completedLeaveReceipt.mockResolvedValue(true);

    const result = await maybeGrantStartBalance(GUILD, CONN, USER);

    expect(result).toEqual({ granted: false, amount: 0n });
    expect(completedLeaveReceipt).toHaveBeenCalledWith(
      String(GUILD), String(USER), '0123456789abcdef0123456789abcdef',
    );
    expect(transaction).not.toHaveBeenCalled();
    expect(txExecuteRaw).not.toHaveBeenCalled();
  });

  it('uses a pseudonymous subject in new start-balance ledger keys', async () => {
    const result = await maybeGrantStartBalance(GUILD, CONN, USER);

    expect(result).toEqual({ granted: true, amount: 5000n });
    const ledgerCall = txExecuteRaw.mock.calls.find(call => String(call[0]).includes('INSERT INTO "EconomyLedgerEntry"'));
    expect(ledgerCall).toBeDefined();
    expect(String(ledgerCall![2])).toMatch(/^startbalance:12345678901234567:conn-1:es1_[a-f0-9]{32}$/);
    expect(String(ledgerCall![2])).not.toContain(String(USER));
    expect(String(ledgerCall![11])).toMatch(/^es1_[a-f0-9]{32}$/);
  });
});
