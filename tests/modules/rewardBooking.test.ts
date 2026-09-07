import { bookPendingRewards, type RewardBookingClient, type PendingRewardRow } from '../../src/modules/economy/rewardBooking';
import type { LedgerTx } from '../../src/modules/economy/ledger';

interface Account { walletBalance: bigint; bankBalance: bigint; lifetimeEarned: bigint; lifetimeSpent: bigint }
interface DecisionState { status: string; paid: bigint; ledgerEntryId?: string; reasonCode?: string }
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
const BASE_TIME = new Date('2026-09-08T10:00:00.000Z');

function decision(id: string, userDiscordId: string, calculated: bigint, offsetSeconds = 0): PendingRewardRow {
  return {
    id,
    userDiscordId,
    calculated,
    rewardRuleId: 'pvp:default',
    createdAt: new Date(BASE_TIME.getTime() + offsetSeconds * 1000),
  };
}

function makeClient(decisions: PendingRewardRow[]) {
  const accounts = new Map<string, Account>();
  const status = new Map<string, DecisionState>();
  const ledger = new Map<string, LedgerRow>();
  let pendingLeave = false;
  let queryLocks = 0;
  let paidToday = 0n;
  let lastPaidAt: Date | null = null;
  let chain: Promise<unknown> = Promise.resolve();

  for (const d of decisions) status.set(d.id, { status: 'PENDING', paid: 0n });

  const rewardDecisionTx = {
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const id = String(where.id);
      const row = decisions.find(d => d.id === id);
      const current = status.get(id);
      const match = Boolean(row
        && current?.status === where.status
        && row.userDiscordId === where.userDiscordId
        && row.calculated === where.calculated);
      if (match) status.set(id, { ...current!, status: String(data.status) });
      return { count: match ? 1 : 0 };
    },
    update: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const id = String(where.id);
      const current = status.get(id) ?? { status: 'PENDING', paid: 0n };
      status.set(id, {
        ...current,
        status: data.status === undefined ? current.status : String(data.status),
        paid: data.paid === undefined ? current.paid : data.paid as bigint,
        ...(data.ledgerEntryId ? { ledgerEntryId: String(data.ledgerEntryId) } : {}),
        ...(data.reasonCode ? { reasonCode: String(data.reasonCode) } : {}),
      });
      return {};
    },
  };

  const tx = {
    $queryRawUnsafe: async (query: string) => {
      if (query.includes('pg_advisory_xact_lock')) {
        queryLocks++;
        return [{ pg_advisory_xact_lock: null }];
      }
      if (query.includes('FROM "RewardDecision"')) return [{ paidToday, lastPaidAt }];
      throw new Error(`unexpected raw query: ${query}`);
    },
    dataDeletionRequest: { findFirst: async () => pendingLeave ? { id: 'leave-1' } : null },
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
        const key = `${w.guildId}:${w.nitradoConnId}:${w.userDiscordId}`;
        if (!accounts.has(key)) {
          accounts.set(key, {
            walletBalance: create.walletBalance as bigint,
            bankBalance: create.bankBalance as bigint,
            lifetimeEarned: create.lifetimeEarned as bigint,
            lifetimeSpent: create.lifetimeSpent as bigint,
          });
        } else {
          const account = accounts.get(key)!;
          account.walletBalance += (update.walletBalance as { increment: bigint }).increment;
          account.bankBalance += (update.bankBalance as { increment: bigint }).increment;
          account.lifetimeEarned += (update.lifetimeEarned as { increment: bigint }).increment;
          account.lifetimeSpent += (update.lifetimeSpent as { increment: bigint }).increment;
        }
        return accounts.get(key);
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
      findMany: async () => decisions.filter(d => status.get(d.id)?.status === 'PENDING'),
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
    setLimits: (limits: { paidToday?: bigint; lastPaidAt?: Date | null }) => {
      if (limits.paidToday !== undefined) paidToday = limits.paidToday;
      if (limits.lastPaidAt !== undefined) lastPaidAt = limits.lastPaidAt;
    },
    queryLockCount: () => queryLocks,
  };
}

describe('bookPendingRewards', () => {
  it('books open rewards on the scoped wallet and marks PAID atomically', async () => {
    const state = makeClient([decision('d1', USER_1, 500n), decision('d2', USER_2, 300n)]);
    const result = await bookPendingRewards(state.client, SCOPE, { rewardTarget: 'WALLET' });
    expect(result).toEqual({ paid: 2, totalAmount: 800n, skipped: 0 });
    expect(state.accounts.get(`${GUILD}:n:${USER_1}`)!.walletBalance).toBe(500n);
    expect(state.status.get('d1')).toMatchObject({ status: 'PAID', paid: 500n, ledgerEntryId: 'ledger-reward:d1' });
    expect(state.queryLockCount()).toBe(2);
  });

  it('never pays the same decision twice', async () => {
    const state = makeClient([decision('d1', USER_1, 500n)]);
    await bookPendingRewards(state.client, SCOPE, { rewardTarget: 'WALLET' });
    const second = await bookPendingRewards(state.client, SCOPE, { rewardTarget: 'WALLET' });
    expect(second).toEqual({ paid: 0, totalAmount: 0n, skipped: 0 });
    expect(state.accounts.get(`${GUILD}:n:${USER_1}`)!.walletBalance).toBe(500n);
    expect(state.ledger.size).toBe(1);
  });

  it('honors the per-rule BANK target', async () => {
    const state = makeClient([decision('d1', USER_1, 250n)]);
    await bookPendingRewards(state.client, SCOPE, { rewardTarget: 'BANK' });
    expect(state.accounts.get(`${GUILD}:n:${USER_1}`)!.bankBalance).toBe(250n);
    expect(state.accounts.get(`${GUILD}:n:${USER_1}`)!.walletBalance).toBe(0n);
  });

  it('serializes parallel bookers and finalizes one decision once', async () => {
    const state = makeClient([decision('d1', USER_1, 500n)]);
    const [a, b] = await Promise.all([
      bookPendingRewards(state.client, SCOPE, { rewardTarget: 'WALLET' }),
      bookPendingRewards(state.client, SCOPE, { rewardTarget: 'WALLET' }),
    ]);
    expect(a.paid + b.paid).toBe(1);
    expect(state.ledger.size).toBe(1);
    expect(state.accounts.get(`${GUILD}:n:${USER_1}`)!.walletBalance).toBe(500n);
  });

  it('blocks a stale pending snapshot while leave cleanup is open', async () => {
    const state = makeClient([decision('d1', USER_1, 500n)]);
    state.setPendingLeave(true);
    const result = await bookPendingRewards(state.client, SCOPE, { rewardTarget: 'WALLET' });
    expect(result).toEqual({ paid: 0, totalAmount: 0n, skipped: 0 });
    expect(state.ledger.size).toBe(0);
    expect(state.accounts.size).toBe(0);
    expect(state.status.get('d1')?.status).toBe('PENDING');
  });

  it('recovers an already committed matching ledger without another money mutation', async () => {
    const state = makeClient([decision('d1', USER_1, 500n)]);
    state.seedLedger({
      id: 'legacy-ledger', idempotencyKey: 'reward:d1', guildId: GUILD, nitradoConnId: 'n', userDiscordId: USER_1,
      walletDelta: 500n, bankDelta: 0n, type: 'GRANT', sourceRef: 'd1',
    });
    const result = await bookPendingRewards(state.client, SCOPE, { rewardTarget: 'WALLET' });
    expect(result).toEqual({ paid: 1, totalAmount: 500n, skipped: 0 });
    expect(state.accounts.size).toBe(0);
    expect(state.ledger.size).toBe(1);
    expect(state.status.get('d1')).toMatchObject({ status: 'PAID', ledgerEntryId: 'legacy-ledger' });
  });

  it('fails closed when an existing reward ledger key belongs to another scope', async () => {
    const state = makeClient([decision('d1', USER_1, 500n)]);
    state.seedLedger({
      id: 'wrong-ledger', idempotencyKey: 'reward:d1', guildId: GUILD, nitradoConnId: 'other-server', userDiscordId: USER_1,
      walletDelta: 500n, bankDelta: 0n, type: 'GRANT', sourceRef: 'd1',
    });
    await expect(bookPendingRewards(state.client, SCOPE, { rewardTarget: 'WALLET' })).rejects.toThrow('Reward-Ledger-Recovery');
    expect(state.accounts.size).toBe(0);
  });

  it('skips once the daily cap is already exhausted', async () => {
    const state = makeClient([decision('d1', USER_1, 500n)]);
    state.setLimits({ paidToday: 1_000n });
    const result = await bookPendingRewards(state.client, SCOPE, { rewardTarget: 'WALLET', dailyCap: 1_000n });
    expect(result).toEqual({ paid: 0, totalAmount: 0n, skipped: 1 });
    expect(state.status.get('d1')).toMatchObject({ status: 'SKIPPED', reasonCode: 'SKIPPED_DAILY_CAP' });
    expect(state.accounts.size).toBe(0);
  });

  it('pays only the remaining amount when a decision crosses the daily cap', async () => {
    const state = makeClient([decision('d1', USER_1, 500n)]);
    state.setLimits({ paidToday: 800n });
    const result = await bookPendingRewards(state.client, SCOPE, { rewardTarget: 'WALLET', dailyCap: 1_000n });
    expect(result).toEqual({ paid: 1, totalAmount: 200n, skipped: 0 });
    expect(state.accounts.get(`${GUILD}:n:${USER_1}`)!.walletBalance).toBe(200n);
    expect(state.status.get('d1')).toMatchObject({ status: 'PAID', paid: 200n, reasonCode: 'PAID_DAILY_CAP_PARTIAL' });
  });

  it('skips a reward inside the configured event-time cooldown', async () => {
    const state = makeClient([decision('d1', USER_1, 500n, 120)]);
    state.setLimits({ lastPaidAt: BASE_TIME });
    const result = await bookPendingRewards(state.client, SCOPE, { rewardTarget: 'WALLET', cooldownSeconds: 300 });
    expect(result).toEqual({ paid: 0, totalAmount: 0n, skipped: 1 });
    expect(state.status.get('d1')).toMatchObject({ status: 'SKIPPED', reasonCode: 'SKIPPED_COOLDOWN' });
    expect(state.accounts.size).toBe(0);
  });
});
