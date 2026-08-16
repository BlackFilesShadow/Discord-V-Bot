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
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({
      economyLinkRewardState: { updateMany: rewardStateUpdateMany },
      economyLedgerEntry: { create: ledgerCreate },
      economyAccount: { upsert: accountUpsert },
      economyTransaction: { findFirst: legacyStartBalanceFindFirst, create: transactionCreate },
    })),
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
  rewardStateFindUnique.mockResolvedValue(null);
  rewardStateUpsert.mockResolvedValue({ rewardEligibleFrom: LINK_AT });
  rewardStateUpdateMany.mockResolvedValue({ count: 1 });
  gameLinkFindFirst.mockResolvedValue({ userDiscordId: USER });
  settingsFindUnique.mockResolvedValue({ economyActive: true });
  economyConfigFindUnique.mockResolvedValue({ startBalance: 5_000 });
  legacyStartBalanceFindFirst.mockResolvedValue(null);
  ledgerCreate.mockResolvedValue({ id: 'ledger-1' });
  accountUpsert.mockResolvedValue({ id: 'account-1' });
  transactionCreate.mockResolvedValue({ id: 'tx-1' });
});

describe('EconomyLinkRewardState', () => {
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
  it('bucht konfiguriertes Startguthaben atomar auch auf ein bestehendes Konto', async () => {
    const result = await grantStartBalanceForLink(SCOPE, USER, LINK_AT);
    expect(result.granted).toBe(true);
    expect(result.amount.toString()).toBe('5000');

    const claim = rewardStateUpdateMany.mock.calls[0][0];
    expect(claim.where).toEqual(expect.objectContaining({ startBalanceEligible: true, startBalanceGrantedAt: null }));
    expect(claim.data.startBalanceEligible).toBe(false);
    expect(claim.data.startBalanceGrantedAt).toEqual(LINK_AT);
    expect(claim.data.startBalanceGrantedAmount.toString()).toBe('5000');

    const ledger = ledgerCreate.mock.calls[0][0].data;
    expect(ledger.idempotencyKey).toBe(`startbalance:link:${SCOPE.guildId}:${SCOPE.nitradoConnId}:${USER}`);
    expect(ledger.walletDelta.toString()).toBe('5000');
    expect(ledger.type).toBe('STARTBALANCE_JOIN');

    const account = accountUpsert.mock.calls[0][0];
    expect(account.update.walletBalance.increment.toString()).toBe('5000');
    expect(account.update.lifetimeEarned.increment.toString()).toBe('5000');

    const transaction = transactionCreate.mock.calls[0][0].data;
    expect(transaction.delta.toString()).toBe('5000');
    expect(transaction.reason).toBe('Startguthaben bei Account-Verknuepfung');
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
    rewardStateUpdateMany.mockResolvedValue({ count: 1 });
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
