const rewardStateFindUnique = jest.fn();
const rewardStateCreate = jest.fn();
const rewardStateUpdate = jest.fn();
const rewardStateUpdateMany = jest.fn();
const gameLinkFindFirst = jest.fn();
const settingsFindUnique = jest.fn();
const economyConfigFindUnique = jest.fn();
const ledgerCreate = jest.fn();
const accountUpsert = jest.fn();
const transactionCreate = jest.fn();

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    economyLinkRewardState: {
      findUnique: rewardStateFindUnique,
      create: rewardStateCreate,
      update: rewardStateUpdate,
      updateMany: rewardStateUpdateMany,
    },
    gameIdentityLink: { findFirst: gameLinkFindFirst },
    serverSettings: { findUnique: settingsFindUnique },
    economyConfig: { findUnique: economyConfigFindUnique },
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({
      economyLinkRewardState: { updateMany: rewardStateUpdateMany },
      economyLedgerEntry: { create: ledgerCreate },
      economyAccount: { upsert: accountUpsert },
      economyTransaction: { create: transactionCreate },
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
  rewardStateCreate.mockResolvedValue({ id: 'state-1' });
  rewardStateUpdate.mockResolvedValue({ id: 'state-1' });
  rewardStateUpdateMany.mockResolvedValue({ count: 1 });
  gameLinkFindFirst.mockResolvedValue({ userDiscordId: USER });
  settingsFindUnique.mockResolvedValue({ economyActive: true });
  economyConfigFindUnique.mockResolvedValue({ startBalance: 5_000 });
  ledgerCreate.mockResolvedValue({ id: 'ledger-1' });
  accountUpsert.mockResolvedValue({ id: 'account-1' });
  transactionCreate.mockResolvedValue({ id: 'tx-1' });
});

describe('EconomyLinkRewardState', () => {
  it('legt fuer einen neuen Link den Reward-Cutoff auf den Linkzeitpunkt', async () => {
    await activateLinkRewardState(SCOPE, USER, GAME_ID, SECRET, true, LINK_AT);
    expect(rewardStateCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        guildId: SCOPE.guildId,
        nitradoConnId: SCOPE.nitradoConnId,
        userDiscordId: USER,
        identityHash: identityHash(GAME_ID, SECRET),
        rewardEligibleFrom: LINK_AT,
        startBalanceEligible: true,
      }),
    });
  });

  it('verschiebt bei idempotentem bereits-verlinkt Aufruf den Cutoff nicht', async () => {
    rewardStateFindUnique.mockResolvedValue({ id: 'state-1' });
    await activateLinkRewardState(SCOPE, USER, GAME_ID, SECRET, false, new Date('2026-08-16T13:00:00Z'));
    expect(rewardStateUpdate).toHaveBeenCalledWith({
      where: { id: 'state-1' },
      data: {
        identityHash: identityHash(GAME_ID, SECRET),
        unlinkedAt: null,
      },
    });
  });

  it('startet beim Relink eine neue Reward-Epoche, aktiviert Startguthaben aber nicht erneut', async () => {
    rewardStateFindUnique.mockResolvedValue({ id: 'state-1' });
    const relinkAt = new Date('2026-08-16T14:00:00Z');
    await activateLinkRewardState(SCOPE, USER, GAME_ID, SECRET, true, relinkAt);
    expect(rewardStateUpdate).toHaveBeenCalledWith({
      where: { id: 'state-1' },
      data: {
        identityHash: identityHash(GAME_ID, SECRET),
        rewardEligibleFrom: relinkAt,
        unlinkedAt: null,
      },
    });
    expect(rewardStateUpdate.mock.calls[0][0].data).not.toHaveProperty('startBalanceEligible');
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
    expect(result).toEqual({ granted: true, amount: 5_000n });
    expect(rewardStateUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ startBalanceEligible: true, startBalanceGrantedAt: null }),
      data: expect.objectContaining({
        startBalanceEligible: false,
        startBalanceGrantedAt: LINK_AT,
        startBalanceGrantedAmount: 5_000n,
      }),
    }));
    expect(ledgerCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        idempotencyKey: `startbalance:link:${SCOPE.guildId}:${SCOPE.nitradoConnId}:${USER}`,
        walletDelta: 5_000n,
        type: 'STARTBALANCE_JOIN',
      }),
    });
    expect(accountUpsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({
        walletBalance: { increment: 5_000n },
        lifetimeEarned: { increment: 5_000n },
      }),
    }));
    expect(transactionCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        delta: 5_000n,
        reason: 'Startguthaben bei Account-Verknuepfung',
      }),
    });
  });

  it('vergibt bei bereits beanspruchtem/Legacy-Link kein neues Startguthaben', async () => {
    rewardStateUpdateMany.mockResolvedValue({ count: 0 });
    const result = await grantStartBalanceForLink(SCOPE, USER, LINK_AT);
    expect(result).toEqual({ granted: false, amount: 0n });
    expect(ledgerCreate).not.toHaveBeenCalled();
    expect(accountUpsert).not.toHaveBeenCalled();
  });

  it('verbraucht die einmalige Eligibility auch wenn Betrag 0 oder Economy deaktiviert ist', async () => {
    economyConfigFindUnique.mockResolvedValueOnce({ startBalance: 0 });
    await expect(grantStartBalanceForLink(SCOPE, USER, LINK_AT)).resolves.toEqual({ granted: false, amount: 0n });
    expect(rewardStateUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: { startBalanceEligible: false },
    }));
    expect(ledgerCreate).not.toHaveBeenCalled();

    jest.clearAllMocks();
    rewardStateUpdateMany.mockResolvedValue({ count: 1 });
    settingsFindUnique.mockResolvedValue({ economyActive: false });
    economyConfigFindUnique.mockResolvedValue({ startBalance: 5_000 });
    await expect(grantStartBalanceForLink(SCOPE, USER, LINK_AT)).resolves.toEqual({ granted: false, amount: 0n });
    expect(rewardStateUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: { startBalanceEligible: false },
    }));
    expect(ledgerCreate).not.toHaveBeenCalled();
  });

  it('faengt konkurrierende doppelte Ledger-Claims fail-safe ab', async () => {
    const unique = new Error('unique') as Error & { code: string };
    unique.code = 'P2002';
    ledgerCreate.mockRejectedValue(unique);
    await expect(grantStartBalanceForLink(SCOPE, USER, LINK_AT)).resolves.toEqual({ granted: false, amount: 0n });
  });
});
