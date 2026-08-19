const rewardStateFindUnique = jest.fn();
const rewardStateUpsert = jest.fn();
const rewardStateUpdateMany = jest.fn();
const gameLinkFindFirst = jest.fn();
const settingsFindUnique = jest.fn();
const economyConfigFindUnique = jest.fn();
const legacyStartBalanceFindFirst = jest.fn();
const ledgerCreate = jest.fn();
const accountUpsert = jest.fn();
const transactionCreate = jest.fn();
const completedLeaveReceipt = jest.fn();
const openLeaveCleanup = jest.fn();
const assertNoOpenLeaveCleanup = jest.fn();
const leaveFenceQuery = jest.fn();
const deletionRequestFindFirst = jest.fn();

class MockLeaveCleanupPendingError extends Error {
  constructor() {
    super('Leave-Cleanup offen');
    this.name = 'LeaveCleanupPendingError';
  }
}

jest.mock('../../src/modules/moderation/leaveCleanupSaga', () => ({
  hasCompletedLeaveCleanupReceipt: (...args: unknown[]) => completedLeaveReceipt(...args),
  leaveCleanupJobKey: (guildId: string, discordId: string) => `leave-job:v1:${guildId}:${discordId}`,
  leaveCleanupReceiptFingerprint: (guildId: string, discordId: string) => `leave-receipt:v1:${guildId}:${discordId}`,
}));

jest.mock('../../src/modules/moderation/leaveCleanupGuard', () => ({
  hasOpenLeaveCleanupRequest: (...args: unknown[]) => openLeaveCleanup(...args),
  assertNoOpenLeaveCleanupRequest: (...args: unknown[]) => assertNoOpenLeaveCleanup(...args),
  LeaveCleanupPendingError: MockLeaveCleanupPendingError,
}));

const tx = {
  $queryRawUnsafe: leaveFenceQuery,
  dataDeletionRequest: { findFirst: deletionRequestFindFirst },
  gameIdentityLink: { findFirst: gameLinkFindFirst },
  economyLinkRewardState: {
    upsert: rewardStateUpsert,
    updateMany: rewardStateUpdateMany,
  },
  economyLedgerEntry: { create: ledgerCreate },
  economyAccount: { upsert: accountUpsert },
  economyTransaction: { findFirst: legacyStartBalanceFindFirst, create: transactionCreate },
};

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    economyLinkRewardState: {
      findUnique: rewardStateFindUnique,
      upsert: rewardStateUpsert,
      updateMany: rewardStateUpdateMany,
    },
    gameIdentityLink: { findFirst: gameLinkFindFirst },
    serverSettings: { findUnique: settingsFindUnique },
    economyConfig: { findUnique: economyConfigFindUnique },
    $transaction: jest.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
  },
}));

import {
  activateLinkRewardState,
  deactivateLinkRewardState,
  grantStartBalanceForLink,
  resolveRewardIdentity,
  resolveRewardUserAt,
} from '../../src/modules/linking/linkRewards';
import { identityHash } from '../../src/modules/linking/identity';

const SCOPE = { guildId: 'guild-1', nitradoConnId: 'conn-1' };
const USER = '111111111111111111';
const GAME_ID = 'guid-1';
const SECRET = 'secret-key';
const LINK_AT = new Date('2026-08-16T12:00:00.000Z');

beforeEach(() => {
  jest.clearAllMocks();
  completedLeaveReceipt.mockResolvedValue(false);
  openLeaveCleanup.mockResolvedValue(false);
  assertNoOpenLeaveCleanup.mockResolvedValue(undefined);
  leaveFenceQuery.mockResolvedValue([]);
  deletionRequestFindFirst.mockResolvedValue(null);
  rewardStateFindUnique.mockResolvedValue(null);
  rewardStateUpsert.mockResolvedValue({ rewardEligibleFrom: LINK_AT });
  rewardStateUpdateMany.mockResolvedValue({ count: 1 });
  gameLinkFindFirst.mockResolvedValue({ userDiscordId: USER, verifiedAt: LINK_AT });
  settingsFindUnique.mockResolvedValue({ economyActive: true });
  economyConfigFindUnique.mockResolvedValue({ startBalance: 5_000 });
  legacyStartBalanceFindFirst.mockResolvedValue(null);
  ledgerCreate.mockResolvedValue({ id: 'ledger-1' });
  accountUpsert.mockResolvedValue({ id: 'account-1' });
  transactionCreate.mockResolvedValue({ id: 'tx-1' });
});

describe('EconomyLinkRewardState', () => {
  it('blockiert eine neue Reward-Epoche fail-closed solange ein Leave-Cleanup offen ist', async () => {
    assertNoOpenLeaveCleanup.mockRejectedValue(new Error('Leave-Cleanup offen'));

    await expect(activateLinkRewardState(SCOPE, USER, GAME_ID, SECRET, true, LINK_AT))
      .rejects.toThrow(/Leave-Cleanup/);
    expect(assertNoOpenLeaveCleanup).toHaveBeenCalledWith(SCOPE.guildId, USER);
    expect(leaveFenceQuery).not.toHaveBeenCalled();
    expect(rewardStateUpsert).not.toHaveBeenCalled();
  });

  it('serialisiert finalen Link-Generationscheck und Reward-State-Upsert mit demselben Leave-Enqueue-Advisory-Key', async () => {
    await activateLinkRewardState(SCOPE, USER, GAME_ID, SECRET, true, LINK_AT);

    expect(leaveFenceQuery).toHaveBeenCalledWith(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      `leave-job:v1:${SCOPE.guildId}:${USER}`,
    );
    expect(deletionRequestFindFirst).toHaveBeenCalledWith({
      where: {
        userId: `leave-job:v1:${SCOPE.guildId}:${USER}`,
        requestType: 'PARTIAL_DELETION',
        status: { in: ['PENDING', 'IN_PROGRESS', 'FAILED'] },
      },
      select: { id: true },
    });
    expect(gameLinkFindFirst).toHaveBeenCalledWith({
      where: {
        guildId: SCOPE.guildId,
        nitradoConnId: SCOPE.nitradoConnId,
        userDiscordId: USER,
        identityHash: identityHash(GAME_ID, SECRET),
        status: 'VERIFIED',
      },
      select: { verifiedAt: true },
    });
    expect(deletionRequestFindFirst).toHaveBeenCalledWith({
      where: {
        userId: `leave-receipt:v1:${SCOPE.guildId}:${USER}`,
        discordId: `leave-receipt:v1:${SCOPE.guildId}:${USER}`,
        requestType: 'PARTIAL_DELETION',
        status: 'COMPLETED',
      },
      select: { id: true, completedAt: true },
      orderBy: { completedAt: 'desc' },
    });
    expect(leaveFenceQuery.mock.invocationCallOrder[0]).toBeLessThan(deletionRequestFindFirst.mock.invocationCallOrder[0]);
    expect(gameLinkFindFirst.mock.invocationCallOrder[0]).toBeLessThan(rewardStateUpsert.mock.invocationCallOrder[0]);
    expect(deletionRequestFindFirst.mock.invocationCallOrder[1]).toBeLessThan(rewardStateUpsert.mock.invocationCallOrder[0]);
  });

  it('faengt ein Leave ab, das nach dem schnellen Guard aber vor dem Upsert eingequeued wurde', async () => {
    deletionRequestFindFirst.mockResolvedValueOnce({ id: 'leave-raced' });

    await expect(activateLinkRewardState(SCOPE, USER, GAME_ID, SECRET, true, LINK_AT))
      .rejects.toBeInstanceOf(MockLeaveCleanupPendingError);

    expect(assertNoOpenLeaveCleanup).toHaveBeenCalledTimes(1);
    expect(leaveFenceQuery).toHaveBeenCalledTimes(1);
    expect(rewardStateUpsert).not.toHaveBeenCalled();
  });

  it('erzeugt nach einem inzwischen vollendeten Cleanup keinen Reward-State fuer einen geloeschten Link', async () => {
    deletionRequestFindFirst.mockResolvedValueOnce(null);
    gameLinkFindFirst.mockResolvedValueOnce(null);

    await expect(activateLinkRewardState(SCOPE, USER, GAME_ID, SECRET, true, LINK_AT))
      .rejects.toBeInstanceOf(MockLeaveCleanupPendingError);
    expect(rewardStateUpsert).not.toHaveBeenCalled();
  });

  it('blockiert eine alte Link-Generation wenn der letzte Cleanup danach abgeschlossen wurde', async () => {
    const completedAt = new Date('2026-08-16T12:00:01.000Z');
    deletionRequestFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'completed-after-link', completedAt });

    await expect(activateLinkRewardState(SCOPE, USER, GAME_ID, SECRET, true, LINK_AT))
      .rejects.toBeInstanceOf(MockLeaveCleanupPendingError);
    expect(rewardStateUpsert).not.toHaveBeenCalled();
  });

  it('erlaubt einen frisch verifizierten Rejoin nach einem aelteren abgeschlossenen Cleanup', async () => {
    const completedAt = new Date('2026-08-16T11:59:59.000Z');
    deletionRequestFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'completed-before-link', completedAt });

    await expect(activateLinkRewardState(SCOPE, USER, GAME_ID, SECRET, true, LINK_AT))
      .resolves.toEqual(LINK_AT);
    expect(rewardStateUpsert).toHaveBeenCalledTimes(1);
  });

  it('legt fuer einen neuen Link den Reward-Cutoff atomar per Upsert auf den Linkzeitpunkt', async () => {
    const cutoff = await activateLinkRewardState(SCOPE, USER, GAME_ID, SECRET, true, LINK_AT);
    expect(cutoff).toEqual(LINK_AT);
    expect(rewardStateUpsert).toHaveBeenCalledTimes(1);
    const args = rewardStateUpsert.mock.calls[0][0];
    expect(args.where).toEqual({
      guildId_nitradoConnId_userDiscordId: {
        guildId: SCOPE.guildId,
        nitradoConnId: SCOPE.nitradoConnId,
        userDiscordId: USER,
      },
    });
    expect(args.create).toMatchObject({
      guildId: SCOPE.guildId,
      nitradoConnId: SCOPE.nitradoConnId,
      userDiscordId: USER,
      identityHash: identityHash(GAME_ID, SECRET),
      rewardEligibleFrom: LINK_AT,
      startBalanceEligible: true,
    });
    expect(args.update).toMatchObject({
      identityHash: identityHash(GAME_ID, SECRET),
      rewardEligibleFrom: LINK_AT,
      unlinkedAt: null,
    });
  });

  it('verschiebt bei idempotentem bereits-verlinkt Aufruf den Cutoff nicht', async () => {
    rewardStateUpsert.mockResolvedValue({ rewardEligibleFrom: LINK_AT });
    const retryAt = new Date('2026-08-16T13:00:00Z');
    const cutoff = await activateLinkRewardState(SCOPE, USER, GAME_ID, SECRET, false, retryAt);
    expect(cutoff).toEqual(LINK_AT);
    const update = rewardStateUpsert.mock.calls[0][0].update;
    expect(update).toEqual({
      identityHash: identityHash(GAME_ID, SECRET),
      unlinkedAt: null,
    });
    expect(update).not.toHaveProperty('rewardEligibleFrom');
  });

  it('startet beim Relink eine neue Reward-Epoche, aktiviert Startguthaben aber nicht erneut', async () => {
    const relinkAt = new Date('2026-08-16T14:00:00Z');
    rewardStateUpsert.mockResolvedValue({ rewardEligibleFrom: relinkAt });
    gameLinkFindFirst.mockResolvedValue({ userDiscordId: USER, verifiedAt: relinkAt });
    await activateLinkRewardState(SCOPE, USER, GAME_ID, SECRET, true, relinkAt);
    const update = rewardStateUpsert.mock.calls[0][0].update;
    expect(update).toEqual({
      identityHash: identityHash(GAME_ID, SECRET),
      rewardEligibleFrom: relinkAt,
      unlinkedAt: null,
    });
    expect(update).not.toHaveProperty('startBalanceEligible');
  });

  it('stoppt bei Unlink die aktive Reward-Epoche', async () => {
    await deactivateLinkRewardState(SCOPE, USER, LINK_AT);
    expect(rewardStateUpdateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        guildId: SCOPE.guildId,
        nitradoConnId: SCOPE.nitradoConnId,
        userDiscordId: USER,
        unlinkedAt: null,
      }),
      data: { unlinkedAt: LINK_AT },
    });
  });

  it('loest GUID nur ueber VERIFIED Link plus passenden aktiven Reward-State auf', async () => {
    rewardStateFindUnique.mockResolvedValue({
      identityHash: identityHash(GAME_ID, SECRET),
      rewardEligibleFrom: LINK_AT,
      unlinkedAt: null,
    });
    await expect(resolveRewardIdentity(SCOPE, GAME_ID, SECRET)).resolves.toEqual({
      userDiscordId: USER,
      rewardEligibleFrom: LINK_AT,
    });

    rewardStateFindUnique.mockResolvedValue({
      identityHash: identityHash(GAME_ID, SECRET),
      rewardEligibleFrom: LINK_AT,
      unlinkedAt: new Date('2026-08-16T12:05:00Z'),
    });
    await expect(resolveRewardIdentity(SCOPE, GAME_ID, SECRET)).resolves.toBeNull();
  });

  it('gibt Event-Rewards ausschliesslich ab dem Linkzeitpunkt frei', async () => {
    rewardStateFindUnique.mockResolvedValue({
      identityHash: identityHash(GAME_ID, SECRET),
      rewardEligibleFrom: LINK_AT,
      unlinkedAt: null,
    });
    await expect(resolveRewardUserAt(SCOPE, GAME_ID, new Date('2026-08-16T11:59:59Z'), SECRET)).resolves.toBeNull();
    await expect(resolveRewardUserAt(SCOPE, GAME_ID, new Date('2026-08-16T12:00:00Z'), SECRET)).resolves.toBe(USER);
    await expect(resolveRewardUserAt(SCOPE, GAME_ID, null, SECRET)).resolves.toBeNull();
  });
});

describe('Startguthaben bei Account-Verknuepfung', () => {
  it('zahlt waehrend eines offenen Leave-Cleanups nichts aus und mutiert keine Eligibility', async () => {
    openLeaveCleanup.mockResolvedValue(true);

    const result = await grantStartBalanceForLink(SCOPE, USER, LINK_AT);

    expect(result).toEqual({ granted: false, amount: 0n });
    expect(completedLeaveReceipt).not.toHaveBeenCalled();
    expect(leaveFenceQuery).not.toHaveBeenCalled();
    expect(rewardStateUpdateMany).not.toHaveBeenCalled();
    expect(settingsFindUnique).not.toHaveBeenCalled();
    expect(ledgerCreate).not.toHaveBeenCalled();
  });

  it('blockiert auch ein Leave, das zwischen Fast-Path und Startbonus-Transaktion eingequeued wurde', async () => {
    deletionRequestFindFirst.mockResolvedValueOnce({ id: 'leave-raced' });

    const result = await grantStartBalanceForLink(SCOPE, USER, LINK_AT);

    expect(result).toEqual({ granted: false, amount: 0n });
    expect(leaveFenceQuery).toHaveBeenCalledTimes(1);
    expect(rewardStateUpdateMany).not.toHaveBeenCalled();
    expect(legacyStartBalanceFindFirst).not.toHaveBeenCalled();
    expect(ledgerCreate).not.toHaveBeenCalled();
    expect(accountUpsert).not.toHaveBeenCalled();
  });

  it('blockiert einen Cleanup, der zwischen Fast-Path und Lock bereits vollendet wurde, und verbraucht Eligibility', async () => {
    deletionRequestFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'completed-raced' });

    const result = await grantStartBalanceForLink(SCOPE, USER, LINK_AT);

    expect(result).toEqual({ granted: false, amount: 0n });
    expect(rewardStateUpdateMany).toHaveBeenCalledWith({
      where: {
        guildId: SCOPE.guildId,
        nitradoConnId: SCOPE.nitradoConnId,
        userDiscordId: USER,
        unlinkedAt: null,
        startBalanceEligible: true,
        startBalanceGrantedAt: null,
      },
      data: { startBalanceEligible: false },
    });
    expect(legacyStartBalanceFindFirst).not.toHaveBeenCalled();
    expect(ledgerCreate).not.toHaveBeenCalled();
    expect(accountUpsert).not.toHaveBeenCalled();
  });

  it('bucht konfiguriertes Startguthaben atomar auch auf ein bestehendes Konto', async () => {
    const result = await grantStartBalanceForLink(SCOPE, USER, LINK_AT);
    expect(result.granted).toBe(true);
    expect(result.amount.toString()).toBe('5000');

    expect(leaveFenceQuery).toHaveBeenCalledWith(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      `leave-job:v1:${SCOPE.guildId}:${USER}`,
    );
    const claim = rewardStateUpdateMany.mock.calls[0][0];
    expect(claim.where).toEqual(expect.objectContaining({ startBalanceEligible: true, startBalanceGrantedAt: null }));
    expect(claim.data.startBalanceEligible).toBe(false);
    expect(claim.data.startBalanceGrantedAt).toEqual(LINK_AT);
    expect(claim.data.startBalanceGrantedAmount.toString()).toBe('5000');

    const ledger = ledgerCreate.mock.calls[0][0].data;
    expect(ledger.idempotencyKey).toMatch(/^startbalance:link:guild-1:conn-1:es1_[a-f0-9]{32}$/);
    expect(ledger.idempotencyKey).not.toContain(USER);
    expect(ledger.sourceRef).toMatch(/^es1_[a-f0-9]{32}$/);
    expect(ledger.walletDelta.toString()).toBe('5000');
    expect(ledger.type).toBe('STARTBALANCE_JOIN');

    const account = accountUpsert.mock.calls[0][0];
    expect(account.update.walletBalance.increment.toString()).toBe('5000');
    expect(account.update.lifetimeEarned.increment.toString()).toBe('5000');

    const transaction = transactionCreate.mock.calls[0][0].data;
    expect(transaction.delta.toString()).toBe('5000');
    expect(transaction.reason).toBe('Startguthaben bei Account-Verknuepfung');
  });

  it('blockiert nach abgeschlossenem Leave-Cleanup jeden erneuten Startbonus und verbraucht die neue Eligibility', async () => {
    completedLeaveReceipt.mockResolvedValue(true);

    const result = await grantStartBalanceForLink(SCOPE, USER, LINK_AT);

    expect(result).toEqual({ granted: false, amount: 0n });
    expect(rewardStateUpdateMany).toHaveBeenCalledWith({
      where: {
        guildId: SCOPE.guildId,
        nitradoConnId: SCOPE.nitradoConnId,
        userDiscordId: USER,
        unlinkedAt: null,
        startBalanceEligible: true,
        startBalanceGrantedAt: null,
      },
      data: { startBalanceEligible: false },
    });
    expect(settingsFindUnique).not.toHaveBeenCalled();
    expect(economyConfigFindUnique).not.toHaveBeenCalled();
    expect(ledgerCreate).not.toHaveBeenCalled();
    expect(accountUpsert).not.toHaveBeenCalled();
  });

  it('vergibt bei bereits beanspruchtem Link kein neues Startguthaben', async () => {
    rewardStateUpdateMany.mockResolvedValue({ count: 0 });
    const result = await grantStartBalanceForLink(SCOPE, USER, LINK_AT);
    expect(result.granted).toBe(false);
    expect(result.amount.toString()).toBe('0');
    expect(ledgerCreate).not.toHaveBeenCalled();
    expect(accountUpsert).not.toHaveBeenCalled();
  });

  it('uebernimmt ein frueheres Discord-Join-Startguthaben und zahlt niemals doppelt', async () => {
    const legacyAt = new Date('2026-08-10T10:00:00.000Z');
    legacyStartBalanceFindFirst.mockResolvedValue({ createdAt: legacyAt, delta: 5_000n });

    const result = await grantStartBalanceForLink(SCOPE, USER, LINK_AT);
    expect(result.granted).toBe(false);
    expect(result.amount.toString()).toBe('0');
    expect(ledgerCreate).not.toHaveBeenCalled();
    expect(accountUpsert).not.toHaveBeenCalled();
    expect(transactionCreate).not.toHaveBeenCalled();

    const consume = rewardStateUpdateMany.mock.calls[0][0];
    expect(consume.data.startBalanceEligible).toBe(false);
    expect(consume.data.startBalanceGrantedAt).toEqual(legacyAt);
    expect(consume.data.startBalanceGrantedAmount.toString()).toBe('5000');
  });

  it('verbraucht die einmalige Eligibility auch wenn Betrag 0 oder Economy deaktiviert ist', async () => {
    economyConfigFindUnique.mockResolvedValueOnce({ startBalance: 0 });
    const zero = await grantStartBalanceForLink(SCOPE, USER, LINK_AT);
    expect(zero.granted).toBe(false);
    expect(zero.amount.toString()).toBe('0');
    expect(rewardStateUpdateMany.mock.calls[0][0].data).toEqual({ startBalanceEligible: false });
    expect(ledgerCreate).not.toHaveBeenCalled();

    jest.clearAllMocks();
    completedLeaveReceipt.mockResolvedValue(false);
    openLeaveCleanup.mockResolvedValue(false);
    assertNoOpenLeaveCleanup.mockResolvedValue(undefined);
    leaveFenceQuery.mockResolvedValue([]);
    deletionRequestFindFirst.mockResolvedValue(null);
    rewardStateUpdateMany.mockResolvedValue({ count: 1 });
    gameLinkFindFirst.mockResolvedValue({ userDiscordId: USER, verifiedAt: LINK_AT });
    settingsFindUnique.mockResolvedValue({ economyActive: false });
    economyConfigFindUnique.mockResolvedValue({ startBalance: 5_000 });
    legacyStartBalanceFindFirst.mockResolvedValue(null);
    const disabled = await grantStartBalanceForLink(SCOPE, USER, LINK_AT);
    expect(disabled.granted).toBe(false);
    expect(disabled.amount.toString()).toBe('0');
    expect(rewardStateUpdateMany.mock.calls[0][0].data).toEqual({ startBalanceEligible: false });
    expect(ledgerCreate).not.toHaveBeenCalled();
  });

  it('faengt konkurrierende doppelte Ledger-Claims fail-safe ab', async () => {
    const unique = new Error('unique') as Error & { code: string };
    unique.code = 'P2002';
    ledgerCreate.mockRejectedValue(unique);
    const result = await grantStartBalanceForLink(SCOPE, USER, LINK_AT);
    expect(result.granted).toBe(false);
    expect(result.amount.toString()).toBe('0');
  });
});
