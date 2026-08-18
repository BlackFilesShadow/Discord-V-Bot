const whitelistStep = jest.fn();
const rootQuery = jest.fn();
const txQuery = jest.fn();
const txExecute = jest.fn();
const transaction = jest.fn();

jest.mock('../../src/config', () => ({
  config: { security: { encryptionKey: '0123456789abcdef0123456789abcdef' } },
}));

jest.mock('../../src/modules/moderation/leaveCleanupWhitelist', () => ({
  runLeaveWhitelistCleanupStep: whitelistStep,
}));

const tx = { $queryRawUnsafe: txQuery, $executeRawUnsafe: txExecute };

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    $queryRawUnsafe: rootQuery,
    $transaction: transaction,
  },
}));

import {
  runLeaveLinkEconomyAfterConfirmedWhitelistStep,
  runLeaveLinkEconomyCleanupStep,
} from '../../src/modules/moderation/leaveCleanupLinkEconomy';

const GUILD = '12345678901234567';
const USER = '22345678901234567';

beforeEach(() => {
  jest.clearAllMocks();
  whitelistStep.mockResolvedValue({ state: 'DONE' });
  rootQuery.mockResolvedValue([{ exists: false }]);
  txQuery.mockResolvedValue([]);
  txExecute.mockImplementation(async (sql: string) => {
    if (sql.startsWith('DELETE FROM "EconomyAccount"')) return 1;
    if (sql.startsWith('DELETE FROM "EconomyLinkRewardState"')) return 1;
    if (sql.startsWith('DELETE FROM "GameIdentityLink"')) return 1;
    return 0;
  });
  transaction.mockImplementation(async (fn: (client: typeof tx) => unknown) => fn(tx));
});

describe('Leave-1E post-whitelist Leave-1C core', () => {
  it('does not rerun whitelist after the orchestrator persisted WHITELIST + STATS checkpoints', async () => {
    const result = await runLeaveLinkEconomyAfterConfirmedWhitelistStep(GUILD, USER);

    expect(result.state).toBe('DONE');
    expect(whitelistStep).not.toHaveBeenCalled();
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(txExecute.mock.calls.some(call => String(call[0]).startsWith('DELETE FROM "GameIdentityLink"'))).toBe(true);
  });

  it('still keeps the standalone wrapper protected by a fresh whitelist completion check', async () => {
    whitelistStep.mockResolvedValue({ state: 'WAITING' });

    const result = await runLeaveLinkEconomyCleanupStep(GUILD, USER);

    expect(result).toMatchObject({ state: 'WAITING', reason: 'WHITELIST_PENDING' });
    expect(whitelistStep).toHaveBeenCalledWith(GUILD, USER);
    expect(rootQuery).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it('fails closed on active lottery even in the post-whitelist core', async () => {
    rootQuery.mockResolvedValue([{ exists: true }]);

    const result = await runLeaveLinkEconomyAfterConfirmedWhitelistStep(GUILD, USER);

    expect(result).toMatchObject({ state: 'WAITING', reason: 'ACTIVE_LOTTERY' });
    expect(transaction).not.toHaveBeenCalled();
  });
});
