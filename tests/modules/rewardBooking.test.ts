/**
 * Phase 5: produktive Reward-Buchung. Kernbeweis: dieselbe Decision bucht NIE
 * doppelt Geld (Ledger-Key reward:<id>), und PENDING wird korrekt auf PAID
 * gehoben.
 */
import {
  bookPendingRewards, type RewardBookingClient, type PendingRewardRow,
} from '../../src/modules/economy/rewardBooking';
import type { LedgerTx } from '../../src/modules/economy/ledger';

interface Account { walletBalance: bigint; bankBalance: bigint; lifetimeEarned: bigint; lifetimeSpent: bigint }

function makeClient(decisions: PendingRewardRow[]) {
  const ledgerKeys = new Set<string>();
  const accounts = new Map<string, Account>();
  const status = new Map<string, { status: string; paid: bigint }>();

  const client: RewardBookingClient = {
    $transaction: async <T>(fn: (tx: LedgerTx) => Promise<T>): Promise<T> => {
      const tx: LedgerTx = {
        economyLedgerEntry: {
          create: async ({ data }) => {
            const key = data.idempotencyKey as string;
            if (ledgerKeys.has(key)) { const e = new Error('unique') as Error & { code: string }; e.code = 'P2002'; throw e; }
            ledgerKeys.add(key);
            return { id: 'ledger-' + key };
          },
        },
        economyAccount: {
          upsert: async ({ where, create, update }) => {
            const w = where.guildId_userDiscordId as { guildId: string; userDiscordId: string };
            const k = `${w.guildId}:${w.userDiscordId}`;
            if (!accounts.has(k)) {
              accounts.set(k, {
                walletBalance: create.walletBalance as bigint, bankBalance: create.bankBalance as bigint,
                lifetimeEarned: create.lifetimeEarned as bigint, lifetimeSpent: create.lifetimeSpent as bigint,
              });
            } else {
              const a = accounts.get(k)!;
              a.walletBalance += (update.walletBalance as { increment: bigint }).increment;
              a.bankBalance += (update.bankBalance as { increment: bigint }).increment;
            }
            return accounts.get(k);
          },
        },
      };
      return fn(tx);
    },
    rewardDecision: {
      findMany: async () => decisions.filter(d => (status.get(d.id)?.status ?? 'PENDING') === 'PENDING'),
      update: async ({ where, data }) => {
        status.set(where.id as string, { status: data.status as string, paid: data.paid as bigint });
        return {};
      },
    },
  };
  return { client, accounts, status };
}

const SCOPE = { guildId: 'g', nitradoConnId: 'n' };

describe('bookPendingRewards', () => {
  it('bucht offene Rewards auf die Wallet und markiert PAID', async () => {
    const { client, accounts, status } = makeClient([
      { id: 'd1', userDiscordId: 'u1', calculated: 500n },
      { id: 'd2', userDiscordId: 'u2', calculated: 300n },
    ]);
    const r = await bookPendingRewards(client, SCOPE, { rewardTarget: 'WALLET' });
    expect(r.paid).toBe(2);
    expect(r.totalAmount).toBe(800n);
    expect(accounts.get('g:u1')!.walletBalance).toBe(500n);
    expect(status.get('d1')!.status).toBe('PAID');
  });

  it('zweiter Lauf zahlt NICHT doppelt (Decisions bereits PAID)', async () => {
    const { client, accounts } = makeClient([{ id: 'd1', userDiscordId: 'u1', calculated: 500n }]);
    await bookPendingRewards(client, SCOPE, { rewardTarget: 'WALLET' });
    const r2 = await bookPendingRewards(client, SCOPE, { rewardTarget: 'WALLET' });
    expect(r2.paid).toBe(0);
    expect(accounts.get('g:u1')!.walletBalance).toBe(500n);
  });

  it('rewardTarget BANK bucht auf die Bank', async () => {
    const { client, accounts } = makeClient([{ id: 'd1', userDiscordId: 'u1', calculated: 250n }]);
    await bookPendingRewards(client, SCOPE, { rewardTarget: 'BANK' });
    expect(accounts.get('g:u1')!.bankBalance).toBe(250n);
    expect(accounts.get('g:u1')!.walletBalance).toBe(0n);
  });
});
