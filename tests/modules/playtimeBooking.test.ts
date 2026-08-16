import {
  bookPlaytimeRewards,
  eligiblePlaytimeBuckets,
  type PlaytimeBookingClient,
  type RewardLinkResolution,
  type UncreditedSession,
} from '../../src/modules/economy/playtimeBooking';
import type { LedgerTx } from '../../src/modules/economy/ledger';

interface Account { walletBalance: bigint; bankBalance: bigint; lifetimeEarned: bigint; lifetimeSpent: bigint }

function makeClient(sessions: UncreditedSession[], links: Record<string, RewardLinkResolution>) {
  const ledgerKeys = new Set<string>();
  const accounts = new Map<string, Account>();
  const progress = new Map<string, number>();

  const client: PlaytimeBookingClient = {
    $transaction: async <T>(fn: (tx: LedgerTx) => Promise<T>): Promise<T> => {
      const tx: LedgerTx = {
        economyLedgerEntry: {
          create: async ({ data }) => {
            const key = data.idempotencyKey as string;
            if (ledgerKeys.has(key)) {
              const e = new Error('unique') as Error & { code: string };
              e.code = 'P2002';
              throw e;
            }
            ledgerKeys.add(key);
            return { id: 'l-' + key };
          },
        },
        economyAccount: {
          upsert: async ({ where, create, update }) => {
            const w = where.guildServerUser as { guildId: string; nitradoConnId: string; userDiscordId: string };
            const k = `${w.guildId}:${w.nitradoConnId}:${w.userDiscordId}`;
            if (!accounts.has(k)) {
              accounts.set(k, {
                walletBalance: create.walletBalance as bigint,
                bankBalance: create.bankBalance as bigint,
                lifetimeEarned: create.lifetimeEarned as bigint,
                lifetimeSpent: create.lifetimeSpent as bigint,
              });
            } else {
              const a = accounts.get(k)!;
              a.walletBalance += (update.walletBalance as { increment: bigint }).increment;
              a.bankBalance += (update.bankBalance as { increment: bigint }).increment;
              a.lifetimeEarned += (update.lifetimeEarned as { increment: bigint }).increment;
              a.lifetimeSpent += (update.lifetimeSpent as { increment: bigint }).increment;
            }
            return accounts.get(k);
          },
        },
      };
      return fn(tx);
    },
    playerSession: {
      findMany: async () => sessions.map(session => ({ ...session })),
    },
    playtimeRewardProgress: {
      findUnique: async (args: unknown) => {
        const keyData = (args as { where: { sessionId_rewardEpoch: { sessionId: string; rewardEpoch: Date } } }).where.sessionId_rewardEpoch;
        const key = `${keyData.sessionId}:${keyData.rewardEpoch.getTime()}`;
        return progress.has(key) ? { bucketsCredited: progress.get(key)! } : null;
      },
      upsert: async ({ where, create, update }) => {
        const keyData = where.sessionId_rewardEpoch as { sessionId: string; rewardEpoch: Date };
        const key = `${keyData.sessionId}:${keyData.rewardEpoch.getTime()}`;
        progress.set(key, Number((update.bucketsCredited ?? create.bucketsCredited) as number));
        return {};
      },
    },
  };

  const resolve = async (gameId: string): Promise<RewardLinkResolution | null> => links[gameId] ?? null;
  return { client, accounts, progress, resolve, ledgerKeys };
}

const SCOPE = { guildId: 'g', nitradoConnId: 'n' };
const LINK_AT = new Date('2026-08-16T12:00:00.000Z');
const NOW = new Date('2026-08-16T12:20:00.000Z');

function session(overrides: Partial<UncreditedSession> = {}): UncreditedSession {
  return {
    id: overrides.id ?? 's1',
    gameId: overrides.gameId ?? 'p1',
    connectedAt: overrides.connectedAt ?? new Date('2026-08-16T12:00:00.000Z'),
    disconnectedAt: overrides.disconnectedAt ?? new Date('2026-08-16T12:20:00.000Z'),
    status: overrides.status ?? 'CLOSED',
  };
}

describe('eligiblePlaytimeBuckets', () => {
  it('zaehlt ausschliesslich volle 10-Minuten-Intervalle NACH dem Link', () => {
    expect(eligiblePlaytimeBuckets(session({
      connectedAt: new Date('2026-08-16T11:55:00.000Z'),
      disconnectedAt: new Date('2026-08-16T12:05:00.000Z'),
    }), LINK_AT, NOW)).toBe(0);

    expect(eligiblePlaytimeBuckets(session({
      connectedAt: new Date('2026-08-16T11:55:00.000Z'),
      disconnectedAt: new Date('2026-08-16T12:15:00.000Z'),
    }), LINK_AT, NOW)).toBe(1);
  });
});

describe('bookPlaytimeRewards ohne Backpay', () => {
  it('zahlt eine komplett vor dem Link beendete Session niemals nachtraeglich', async () => {
    const { client, accounts, resolve } = makeClient([
      session({
        connectedAt: new Date('2026-08-16T09:00:00.000Z'),
        disconnectedAt: new Date('2026-08-16T11:00:00.000Z'),
      }),
    ], { p1: { userDiscordId: 'u1', rewardEligibleFrom: LINK_AT } });

    const result = await bookPlaytimeRewards(client, SCOPE, { perBucketAmount: 100n, rewardTarget: 'WALLET', now: NOW }, resolve);
    expect(result).toEqual({ credited: 0, total: 0n });
    expect(accounts.get('g:n:u1')).toBeUndefined();
  });

  it('zahlt bei einer laufenden Session nur volle Zeit ab dem Link-Cutoff', async () => {
    const { client, accounts, resolve } = makeClient([
      session({
        connectedAt: new Date('2026-08-16T11:55:00.000Z'),
        disconnectedAt: null,
        status: 'OPEN',
      }),
    ], { p1: { userDiscordId: 'u1', rewardEligibleFrom: LINK_AT } });

    const result = await bookPlaytimeRewards(client, SCOPE, { perBucketAmount: 100n, rewardTarget: 'WALLET', now: NOW }, resolve);
    expect(result).toEqual({ credited: 2, total: 200n });
    expect(accounts.get('g:n:u1')!.walletBalance).toBe(200n);
  });

  it('zweiter Lauf derselben Link-Epoche zahlt keinen Bucket doppelt', async () => {
    const { client, accounts, resolve } = makeClient(
      [session()],
      { p1: { userDiscordId: 'u1', rewardEligibleFrom: LINK_AT } },
    );
    await bookPlaytimeRewards(client, SCOPE, { perBucketAmount: 100n, rewardTarget: 'WALLET', now: NOW }, resolve);
    const second = await bookPlaytimeRewards(client, SCOPE, { perBucketAmount: 100n, rewardTarget: 'WALLET', now: NOW }, resolve);
    expect(second).toEqual({ credited: 0, total: 0n });
    expect(accounts.get('g:n:u1')!.walletBalance).toBe(200n);
  });

  it('unverlinkter Spieler bleibt ohne Auszahlung und ohne offene spaetere Nachzahlung', async () => {
    const { client, accounts, resolve } = makeClient([session()], {});
    const result = await bookPlaytimeRewards(client, SCOPE, { perBucketAmount: 100n, rewardTarget: 'WALLET', now: NOW }, resolve);
    expect(result).toEqual({ credited: 0, total: 0n });
    expect(accounts.size).toBe(0);
  });

  it('eine neue Relink-Epoche beginnt mathematisch wieder bei deren Zeitpunkt', async () => {
    const s = session({
      connectedAt: new Date('2026-08-16T11:50:00.000Z'),
      disconnectedAt: null,
      status: 'OPEN',
    });
    const links: Record<string, RewardLinkResolution> = {
      p1: { userDiscordId: 'u1', rewardEligibleFrom: LINK_AT },
    };
    const { client, accounts, resolve } = makeClient([s], links);

    await bookPlaytimeRewards(client, SCOPE, {
      perBucketAmount: 100n,
      rewardTarget: 'WALLET',
      now: new Date('2026-08-16T12:10:00.000Z'),
    }, resolve);
    expect(accounts.get('g:n:u1')!.walletBalance).toBe(100n);

    links.p1 = { userDiscordId: 'u1', rewardEligibleFrom: new Date('2026-08-16T12:12:00.000Z') };
    await bookPlaytimeRewards(client, SCOPE, {
      perBucketAmount: 100n,
      rewardTarget: 'WALLET',
      now: new Date('2026-08-16T12:22:00.000Z'),
    }, resolve);
    expect(accounts.get('g:n:u1')!.walletBalance).toBe(200n);
  });
});
