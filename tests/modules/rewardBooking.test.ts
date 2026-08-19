/**
 * Produktive Reward-Buchung: Scope, Parallelitaet, Crash-Recovery und
 * Leave-Cleanup-Fence. Geld + Decision-State muessen atomar zusammenbleiben.
 */
import {
  bookPendingRewards, type RewardBookingClient, type PendingRewardRow,
} from '../../src/modules/economy/rewardBooking';
import type { LedgerTx } from '../../src/modules/economy/ledger';

interface Account { walletBalance: bigint; bankBalance: bigint; lifetimeEarned: bigint; lifetimeSpent: bigint }
interface DecisionState { status: string; paid: bigint; ledgerEntryId?: string }
interface LedgerRow {
  id: string;
  idempotencyKey: string;
  guildId: string;
  nitradoConnId: string;
  userDiscordId: string;
  walletDelta: bigint;
  bankDelta: bigint;
  type: string;
  sourceRef: string | null;
}

const GUILD = '123456789012345678';
const USER_1 = '223456789012345678';
const USER_2 = '323456789012345678';
const SCOPE = { guildId: GUILD, nitradoConnId: 'n' };

function makeClient(decisions: PendingRewardRow[]) {
  const accounts = new Map<string, Account>();
  const status = new Map<string, DecisionState>();
  const ledger = new Map<string, LedgerRow>();
  let pendingLeave = false;
  let queryLocks = 0;
  let chain: Promise<unknown> = Promise.resolve();

  for (const d of decisions) status.set(d.id, { status: 'PENDING', paid: 0n });

  const rewardDecisionTx = {
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const id = String(where.id);
      const decision = decisions.find((d) => d.id === id);
      const current = status.get(id);
      const match = Boolean(
        decision
        && current?.status === where.status
        && decision.userDiscordId === where.userDiscordId
        && decision.calculated === where.calculated,
      );
      if (match) status.set(id, { ...current!, status: String(data.status) });
      return { count: match ? 1 : 0 };
    },
    update: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const id = String(where.id);
      status.set(id, {
        status: String(data.status),
        paid: data.paid as bigint,
        ...(data.ledgerEntryId ? { ledgerEntryId: String(data.ledgerEntryId) } : {}),
      });
      return {};
    },
  };

  const tx = {
    $queryRawUnsafe: async () => { queryLocks++; return [{ pg_advisory_xact_lock: null }]; },
    dataDeletionRequest: {
      findFirst: async () => pendingLeave ? { id: 'leave-1' } : null,
    },
    rewardDecision: rewardDecisionTx,
    economyLedgerEntry: {
      findUnique: async (args: unknown) => {
        const key = String((args as { where: { idempotencyKey: string } }).where.idempotencyKey);
        return ledger.get(key) ?? null;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const key = String(data.idempotencyKey);
        if (ledger.has(key)) {
          const e = new Error('unique') as Error & { code: string };
          e.code = 'P2002';
          throw e;
        }
        const row: LedgerRow = {
          id: `ledger-${key}`,
          idempotencyKey: key,
          guildId: String(data.guildId),
          nitradoConnId: String(data.nitradoConnId),
          userDiscordId: String(data.userDiscordId),
          walletDelta: data.walletDelta as bigint,
          bankDelta: data.bankDelta as bigint,
          type: String(data.type),
          sourceRef: data.sourceRef === null || data.sourceRef === undefined ? null : String(data.sourceRef),
        };
        ledger.set(key, row);
        return { id: row.id };
      },
    },
    economyAccount: {
      upsert: async ({ where, create, update }: { where: Record<string, unknown>; create: Record<string, unknown>; update: Record<string, unknown> }) => {
        const w = (where as { guildServerUser: { guildId: string; nitradoConnId: string; userDiscordId: string } }).guildServerUser;
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

  const client: RewardBookingClient = {
    $transaction: async <T>(fn: (trx: LedgerTx) => Promise<T>): Promise<T> => {
      const run = chain.then(() => fn(tx as unknown as LedgerTx));
      chain = run.then(() => undefined, () => undefined);
      return run;
    },
    rewardDecision: {
      findMany: async () => decisions.filter((d) => status.get(d.id)?.status === 'PENDING'),
      update: rewardDecisionTx.update,
    },
  };

  return {
    client,
    accounts,
    status,
    ledger,
    setPendingLeave: (value: boolean) => { pendingLeave = value; },
    seedLedger: (row: LedgerRow) => ledger.set(row.idempotencyKey, row),
    queryLockCount: () => queryLocks,
  };
}

describe('bookPendingRewards', () => {
  it('bucht offene Rewards auf die servergescoppte Wallet und markiert PAID atomar', async () => {
    const { client, accounts, status, queryLockCount } = makeClient([
      { id: 'd1', userDiscordId: USER_1, calculated: 500n },
      { id: 'd2', userDiscordId: USER_2, calculated: 300n },
    ]);
    const r = await bookPendingRewards(client, SCOPE, { rewardTarget: 'WALLET' });
    expect(r).toEqual({ paid: 2, totalAmount: 800n });
    expect(accounts.get(`${GUILD}:n:${USER_1}`)!.walletBalance).toBe(500n);
    expect(status.get('d1')).toMatchObject({ status: 'PAID', paid: 500n, ledgerEntryId: 'ledger-reward:d1' });
    expect(queryLockCount()).toBe(2);
  });

  it('zweiter Lauf zahlt NICHT doppelt', async () => {
    const state = makeClient([{ id: 'd1', userDiscordId: USER_1, calculated: 500n }]);
    await bookPendingRewards(state.client, SCOPE, { rewardTarget: 'WALLET' });
    const r2 = await bookPendingRewards(state.client, SCOPE, { rewardTarget: 'WALLET' });
    expect(r2.paid).toBe(0);
    expect(state.accounts.get(`${GUILD}:n:${USER_1}`)!.walletBalance).toBe(500n);
    expect(state.ledger.size).toBe(1);
  });

  it('rewardTarget BANK bucht auf die servergescoppte Bank', async () => {
    const state = makeClient([{ id: 'd1', userDiscordId: USER_1, calculated: 250n }]);
    await bookPendingRewards(state.client, SCOPE, { rewardTarget: 'BANK' });
    expect(state.accounts.get(`${GUILD}:n:${USER_1}`)!.bankBalance).toBe(250n);
    expect(state.accounts.get(`${GUILD}:n:${USER_1}`)!.walletBalance).toBe(0n);
  });

  it('parallel gestartete Booker finalisieren dieselbe Decision nur einmal', async () => {
    const state = makeClient([{ id: 'd1', userDiscordId: USER_1, calculated: 500n }]);
    const [a, b] = await Promise.all([
      bookPendingRewards(state.client, SCOPE, { rewardTarget: 'WALLET' }),
      bookPendingRewards(state.client, SCOPE, { rewardTarget: 'WALLET' }),
    ]);
    expect(a.paid + b.paid).toBe(1);
    expect(state.ledger.size).toBe(1);
    expect(state.accounts.get(`${GUILD}:n:${USER_1}`)!.walletBalance).toBe(500n);
    expect(state.status.get('d1')?.status).toBe('PAID');
  });

  it('blockiert einen stale PENDING-Snapshot sobald Leave-Cleanup offen ist', async () => {
    const state = makeClient([{ id: 'd1', userDiscordId: USER_1, calculated: 500n }]);
    state.setPendingLeave(true);
    const result = await bookPendingRewards(state.client, SCOPE, { rewardTarget: 'WALLET' });
    expect(result).toEqual({ paid: 0, totalAmount: 0n });
    expect(state.ledger.size).toBe(0);
    expect(state.accounts.size).toBe(0);
    expect(state.status.get('d1')?.status).toBe('PENDING');
  });

  it('recovered einen alten Ledger-Commit ohne zweite Geldmutation', async () => {
    const state = makeClient([{ id: 'd1', userDiscordId: USER_1, calculated: 500n }]);
    state.seedLedger({
      id: 'legacy-ledger',
      idempotencyKey: 'reward:d1',
      guildId: GUILD,
      nitradoConnId: 'n',
      userDiscordId: USER_1,
      walletDelta: 500n,
      bankDelta: 0n,
      type: 'GRANT',
      sourceRef: 'd1',
    });
    const result = await bookPendingRewards(state.client, SCOPE, { rewardTarget: 'WALLET' });
    expect(result).toEqual({ paid: 1, totalAmount: 500n });
    expect(state.accounts.size).toBe(0);
    expect(state.ledger.size).toBe(1);
    expect(state.status.get('d1')).toMatchObject({ status: 'PAID', ledgerEntryId: 'legacy-ledger' });
  });

  it('failt geschlossen wenn ein vorhandener Reward-Ledger-Key fachlich nicht passt', async () => {
    const state = makeClient([{ id: 'd1', userDiscordId: USER_1, calculated: 500n }]);
    state.seedLedger({
      id: 'wrong-ledger',
      idempotencyKey: 'reward:d1',
      guildId: GUILD,
      nitradoConnId: 'other-server',
      userDiscordId: USER_1,
      walletDelta: 500n,
      bankDelta: 0n,
      type: 'GRANT',
      sourceRef: 'd1',
    });
    await expect(bookPendingRewards(state.client, SCOPE, { rewardTarget: 'WALLET' }))
      .rejects.toThrow('Reward-Ledger-Recovery');
    expect(state.accounts.size).toBe(0);
  });
});
