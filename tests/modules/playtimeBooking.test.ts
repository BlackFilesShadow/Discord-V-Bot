/**
 * Phase 5: produktive Spielzeit-Rewards. Kernbeweis: dieselbe Bucket-Stufe zahlt
 * NIE doppelt (Ledger-Key playtime:<session>:<bucketsEarned>), neue Buckets
 * werden nachgebucht, unverlinkte Spieler uebersprungen.
 */
import {
  bookPlaytimeRewards, type PlaytimeBookingClient, type UncreditedSession,
} from '../../src/modules/economy/playtimeBooking';
import type { LedgerTx } from '../../src/modules/economy/ledger';

interface Account { walletBalance: bigint; bankBalance: bigint; lifetimeEarned: bigint; lifetimeSpent: bigint }

function makeClient(sessions: UncreditedSession[], links: Record<string, string>) {
  const ledgerKeys = new Set<string>();
  const accounts = new Map<string, Account>();
  const credited = new Map<string, number>();

  const client: PlaytimeBookingClient = {
    $transaction: async <T>(fn: (tx: LedgerTx) => Promise<T>): Promise<T> => {
      const tx: LedgerTx = {
        economyLedgerEntry: {
          create: async ({ data }) => {
            const key = data.idempotencyKey as string;
            if (ledgerKeys.has(key)) { const e = new Error('u') as Error & { code: string }; e.code = 'P2002'; throw e; }
            ledgerKeys.add(key);
            return { id: 'l-' + key };
          },
        },
        economyAccount: {
          upsert: async ({ where, create, update }) => {
            const w = where.guildId_userDiscordId as { guildId: string; userDiscordId: string };
            const k = `${w.guildId}:${w.userDiscordId}`;
            if (!accounts.has(k)) accounts.set(k, { walletBalance: create.walletBalance as bigint, bankBalance: create.bankBalance as bigint, lifetimeEarned: 0n, lifetimeSpent: 0n });
            else accounts.get(k)!.walletBalance += (update.walletBalance as { increment: bigint }).increment;
            return accounts.get(k);
          },
        },
      };
      return fn(tx);
    },
    playerSession: {
      findMany: async () => sessions.map(s => ({ ...s, bucketsCredited: credited.get(s.id) ?? s.bucketsCredited })),
      update: async ({ where, data }) => { credited.set(where.id as string, data.bucketsCredited as number); return {}; },
    },
  };
  const resolve = async (gameId: string): Promise<string | null> => links[gameId] ?? null;
  return { client, accounts, credited, resolve };
}

const SCOPE = { guildId: 'g', nitradoConnId: 'n' };

describe('bookPlaytimeRewards', () => {
  it('bucht neue Buckets und hebt bucketsCredited an', async () => {
    const { client, accounts, credited, resolve } = makeClient(
      [{ id: 's1', gameId: 'p1', bucketsEarned: 3, bucketsCredited: 0 }],
      { p1: 'u1' },
    );
    const r = await bookPlaytimeRewards(client, SCOPE, { perBucketAmount: 100n, rewardTarget: 'WALLET' }, resolve);
    expect(r.credited).toBe(1);
    expect(r.total).toBe(300n);
    expect(accounts.get('g:u1')!.walletBalance).toBe(300n);
    expect(credited.get('s1')).toBe(3);
  });

  it('zweiter Lauf ohne neue Buckets zahlt nichts', async () => {
    const { client, accounts, resolve } = makeClient(
      [{ id: 's1', gameId: 'p1', bucketsEarned: 3, bucketsCredited: 0 }],
      { p1: 'u1' },
    );
    await bookPlaytimeRewards(client, SCOPE, { perBucketAmount: 100n, rewardTarget: 'WALLET' }, resolve);
    const r2 = await bookPlaytimeRewards(client, SCOPE, { perBucketAmount: 100n, rewardTarget: 'WALLET' }, resolve);
    expect(r2.credited).toBe(0);
    expect(accounts.get('g:u1')!.walletBalance).toBe(300n);
  });

  it('unverlinkter Spieler wird uebersprungen', async () => {
    const { client, accounts, credited, resolve } = makeClient(
      [{ id: 's1', gameId: 'p1', bucketsEarned: 2, bucketsCredited: 0 }],
      {},
    );
    const r = await bookPlaytimeRewards(client, SCOPE, { perBucketAmount: 100n, rewardTarget: 'WALLET' }, resolve);
    expect(r.credited).toBe(0);
    expect(accounts.get('g:u1')).toBeUndefined();
    expect(credited.get('s1')).toBeUndefined();
  });

  it('perBucketAmount 0 -> nichts', async () => {
    const { client, resolve } = makeClient([{ id: 's1', gameId: 'p1', bucketsEarned: 5, bucketsCredited: 0 }], { p1: 'u1' });
    const r = await bookPlaytimeRewards(client, SCOPE, { perBucketAmount: 0n, rewardTarget: 'WALLET' }, resolve);
    expect(r.credited).toBe(0);
  });
});
