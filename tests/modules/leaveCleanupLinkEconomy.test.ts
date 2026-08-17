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

const tx = {
  $queryRawUnsafe: txQuery,
  $executeRawUnsafe: txExecute,
};

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    $queryRawUnsafe: rootQuery,
    $transaction: transaction,
  },
}));

import { runLeaveLinkEconomyCleanupStep } from '../../src/modules/moderation/leaveCleanupLinkEconomy';

const GUILD = '12345678901234567';
const USER = '22345678901234567';

beforeEach(() => {
  jest.clearAllMocks();
  whitelistStep.mockResolvedValue({ state: 'DONE' });
  rootQuery.mockResolvedValue([{ exists: false }]);
  txQuery.mockResolvedValue([]);
  txExecute.mockImplementation(async (sql: string) => {
    if (sql.includes('UPDATE "RewardDecision"') && sql.includes("'LEAVE_RESET'")) return 2;
    if (sql.startsWith('DELETE FROM "EconomyAccount"')) return 3;
    if (sql.startsWith('DELETE FROM "EconomyLinkRewardState"')) return 2;
    if (sql.startsWith('DELETE FROM "GameIdentityLink"')) return 2;
    return 1;
  });
  transaction.mockImplementation(async (fn: (client: typeof tx) => unknown) => fn(tx));
});

describe('Leave-1C link/economy cleanup', () => {
  it('waits without touching economy while whitelist remote removal is still pending', async () => {
    whitelistStep.mockResolvedValue({ state: 'WAITING' });

    const result = await runLeaveLinkEconomyCleanupStep(GUILD, USER);

    expect(result.state).toBe('WAITING');
    expect(result.reason).toBe('WHITELIST_PENDING');
    expect(rootQuery).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it('fails closed on active lottery obligations before deleting an account', async () => {
    rootQuery.mockResolvedValue([{ exists: true }]);

    const result = await runLeaveLinkEconomyCleanupStep(GUILD, USER);

    expect(result).toMatchObject({ state: 'WAITING', reason: 'ACTIVE_LOTTERY' });
    expect(rootQuery.mock.calls[0][1]).toBe(GUILD);
    expect(rootQuery.mock.calls[0][2]).toBe(USER);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('pseudonymizes anti-replay/accounting history before deleting mutable account, reward-state and links', async () => {
    const result = await runLeaveLinkEconomyCleanupStep(GUILD, USER);

    expect(result.state).toBe('DONE');
    expect(result.subjectKey).toMatch(/^es1_[a-f0-9]{32}$/);
    expect(result.subjectKey).not.toContain(USER);
    expect(result.rewardDecisionsSkipped).toBe(2);
    expect(result.accountsDeleted).toBe(3);
    expect(result.rewardStatesDeleted).toBe(2);
    expect(result.linksDeleted).toBe(2);

    const sqls = txExecute.mock.calls.map(call => String(call[0]));
    expect(sqls.some(sql => sql.includes('UPDATE "RewardDecision"') && sql.includes("'LEAVE_RESET'"))).toBe(true);
    expect(sqls.some(sql => sql.includes('UPDATE "PlaytimeRewardProgress"'))).toBe(true);
    expect(sqls.some(sql => sql.includes('UPDATE "EconomyLedgerEntry"') && sql.includes('replace("idempotencyKey", $2, $3)'))).toBe(true);
    expect(sqls.some(sql => sql.startsWith('DELETE FROM "EconomyAccount"'))).toBe(true);
    expect(sqls.some(sql => sql.startsWith('DELETE FROM "EconomyLinkRewardState"'))).toBe(true);
    expect(sqls.some(sql => sql.startsWith('DELETE FROM "GameIdentityLink"'))).toBe(true);
    expect(sqls.some(sql => sql.includes('PlayerSession'))).toBe(false);

    for (const call of txExecute.mock.calls) {
      const sql = String(call[0]);
      if (sql.includes('"guildId"=$1') || sql.includes('"guildId" = $1')) {
        expect(call[1]).toBe(GUILD);
      }
    }
  });

  it('aborts atomically before history mutation when a transformed ledger key would collide', async () => {
    txQuery.mockResolvedValue([{ id: 'collision' }]);

    await expect(runLeaveLinkEconomyCleanupStep(GUILD, USER)).rejects.toThrow(/kollidiert/);

    expect(txExecute).not.toHaveBeenCalled();
    expect(txQuery.mock.calls[0][1]).toBe(GUILD);
    expect(txQuery.mock.calls[0][2]).toBe(USER);
    expect(String(txQuery.mock.calls[0][0])).toContain('replace(old."idempotencyKey", $2, $3)');
  });

  it('uses exact guild+user deletes instead of guild-global cleanup', async () => {
    await runLeaveLinkEconomyCleanupStep(GUILD, USER);

    const deleteCalls = txExecute.mock.calls.filter(call => String(call[0]).startsWith('DELETE FROM'));
    expect(deleteCalls).toHaveLength(3);
    for (const call of deleteCalls) {
      expect(String(call[0])).toContain('"guildId"=$1 AND "userDiscordId"=$2');
      expect(call[1]).toBe(GUILD);
      expect(call[2]).toBe(USER);
    }
  });
});
