import {
  bookPlaytimeRewards,
  eligiblePlaytimeBuckets,
  type PlaytimeBookingClient,
  type RewardLinkResolution,
  type UncreditedSession,
} from '../../src/modules/economy/playtimeBooking';
import type { LedgerTx } from '../../src/modules/economy/ledger';

interface Account { walletBalance: bigint; bankBalance: bigint; lifetimeEarned: bigint; lifetimeSpent: bigint }
interface LedgerRow {
  id: string;
  guildId: string;
  nitradoConnId: string;
  userDiscordId: string;
  type: string;
  buckets: number;
  sourceRef: string | null;
}

const GUILD = '123456789012345678';
const USER = '223456789012345678';
const SCOPE = { guildId: GUILD, nitradoConnId: 'n' };
const LINK_AT = new Date('2026-08-16T12:00:00.000Z');
const NOW = new Date('2026-08-16T12:20:00.000Z');
const HASH_1 = 'a'.repeat(64);
const HASH_2 = 'b'.repeat(64);

function link(overrides: Partial<RewardLinkResolution> = {}): RewardLinkResolution {
  return {
    userDiscordId: overrides.userDiscordId ?? USER,
    rewardEligibleFrom: overrides.rewardEligibleFrom ?? LINK_AT,
    identityHash: overrides.identityHash ?? HASH_1,
  };
}

function session(overrides: Partial<UncreditedSession> = {}): UncreditedSession {
  const has = (key: keyof UncreditedSession) => Object.prototype.hasOwnProperty.call(overrides, key);
  const connectedAt = has('connectedAt') ? (overrides.connectedAt ?? null) : LINK_AT;
  const disconnectedAt = has('disconnectedAt') ? (overrides.disconnectedAt ?? null) : NOW;
  return {
    id: overrides.id ?? 's1',
    gameId: overrides.gameId ?? 'p1',
    connectedAt,
    disconnectedAt,
    status: overrides.status ?? 'CLOSED',
    createdAt: overrides.createdAt ?? connectedAt ?? LINK_AT,
    updatedAt: overrides.updatedAt ?? disconnectedAt ?? connectedAt ?? LINK_AT,
  };
}

function makeClient(sessions: UncreditedSession[], links: Record<string, RewardLinkResolution>) {
  const ledger = new Map<string, LedgerRow>();
  const accounts = new Map<string, Account>();
  const progress = new Map<string, { bucketsCredited: number; userDiscordId: string }>();
  const cursors = new Map<string, { lastTimestamp: Date; lastEntityId: string }>();
  let pendingLeave = false;
  let resolveHook: ((gameId: string, snapshot: RewardLinkResolution | null) => void) | null = null;
  let chain: Promise<unknown> = Promise.resolve();

  const tx = {
    $queryRawUnsafe: async <T = unknown>(query: string, ...values: unknown[]): Promise<T> => {
      if (query.includes('pg_advisory_xact_lock')) return [{ pg_advisory_xact_lock: null }] as T;
      if (query.includes('FROM "EconomyLinkRewardState"')) {
        const user = String(values[2]);
        const current = Object.values(links).find((value) => value.userDiscordId === user);
        return (current ? [{
          identityHash: current.identityHash,
          rewardEligibleFrom: current.rewardEligibleFrom,
          unlinkedAt: null,
        }] : []) as T;
      }
      throw new Error(`unexpected raw query: ${query}`);
    },
    dataDeletionRequest: {
      findFirst: async () => pendingLeave ? { id: 'leave-1' } : null,
    },
    economyLedgerEntry: {
      findUnique: async (args: unknown) => {
        const key = String((args as { where: { idempotencyKey: string } }).where.idempotencyKey);
        return ledger.get(key) ?? null;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const key = String(data.idempotencyKey);
        if (ledger.has(key)) {
          const error = new Error('unique') as Error & { code: string };
          error.code = 'P2002';
          throw error;
        }
        const row: LedgerRow = {
          id: `l-${key}`,
          guildId: String(data.guildId),
          nitradoConnId: String(data.nitradoConnId),
          userDiscordId: String(data.userDiscordId),
          type: String(data.type),
          buckets: Number(data.buckets ?? 0),
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
    playtimeRewardProgress: {
      findUnique: async (args: unknown) => {
        const keyData = (args as { where: { sessionId_rewardEpoch: { sessionId: string; rewardEpoch: Date } } }).where.sessionId_rewardEpoch;
        return progress.get(`${keyData.sessionId}:${keyData.rewardEpoch.getTime()}`) ?? null;
      },
      upsert: async ({ where, create, update }: { where: Record<string, unknown>; create: Record<string, unknown>; update: Record<string, unknown> }) => {
        const keyData = where.sessionId_rewardEpoch as { sessionId: string; rewardEpoch: Date };
        const key = `${keyData.sessionId}:${keyData.rewardEpoch.getTime()}`;
        progress.set(key, {
          bucketsCredited: Number((update.bucketsCredited ?? create.bucketsCredited) as number),
          userDiscordId: String(update.userDiscordId ?? create.userDiscordId),
        });
        return {};
      },
    },
  };

  const client: PlaytimeBookingClient = {
    $transaction: async <T>(fn: (trx: LedgerTx) => Promise<T>): Promise<T> => {
      const run = chain.then(() => fn(tx as unknown as LedgerTx));
      chain = run.then(() => undefined, () => undefined);
      return run;
    },
    playerSession: {
      findMany: async (args: unknown) => {
        const a = args as { where: { status?: 'OPEN' | 'CLOSED'; OR?: Array<Record<string, unknown>> }; take?: number };
        let rows = sessions.filter((value) => !a.where.status || value.status === a.where.status);
        if (a.where.OR) {
          const first = a.where.OR[0] as { updatedAt?: { gt?: Date } };
          const second = a.where.OR[1] as { updatedAt?: Date; id?: { gt?: string } };
          const ts = first.updatedAt?.gt ?? new Date(0);
          const id = second.id?.gt ?? '';
          rows = rows.filter((value) => value.updatedAt > ts || (value.updatedAt.getTime() === ts.getTime() && value.id > id));
        }
        rows = [...rows].sort((aRow, bRow) => {
          const aTs = a.where.status === 'CLOSED' ? aRow.updatedAt : aRow.createdAt;
          const bTs = a.where.status === 'CLOSED' ? bRow.updatedAt : bRow.createdAt;
          return aTs.getTime() - bTs.getTime() || aRow.id.localeCompare(bRow.id);
        });
        return rows.slice(0, a.take ?? rows.length).map((value) => ({ ...value }));
      },
    },
    rewardProcessingCursor: {
      upsert: async (args: unknown) => {
        const w = (args as { where: { guildId_nitradoConnId_stream: { guildId: string; nitradoConnId: string; stream: string } } }).where.guildId_nitradoConnId_stream;
        const key = `${w.guildId}:${w.nitradoConnId}:${w.stream}`;
        if (!cursors.has(key)) cursors.set(key, { lastTimestamp: new Date(0), lastEntityId: '' });
        return { ...cursors.get(key)! };
      },
      updateMany: async (args: unknown) => {
        const a = args as { where: { guildId: string; nitradoConnId: string; stream: string }; data: { lastTimestamp: Date; lastEntityId: string } };
        const key = `${a.where.guildId}:${a.where.nitradoConnId}:${a.where.stream}`;
        const current = cursors.get(key) ?? { lastTimestamp: new Date(0), lastEntityId: '' };
        const next = { lastTimestamp: a.data.lastTimestamp, lastEntityId: a.data.lastEntityId };
        const ahead = next.lastTimestamp > current.lastTimestamp
          || (next.lastTimestamp.getTime() === current.lastTimestamp.getTime() && next.lastEntityId > current.lastEntityId);
        if (ahead) cursors.set(key, next);
        return { count: ahead ? 1 : 0 };
      },
    },
  };

  const resolve = async (gameId: string): Promise<RewardLinkResolution | null> => {
    const current = links[gameId] ? { ...links[gameId] } : null;
    resolveHook?.(gameId, current);
    return current;
  };

  return {
    client,
    accounts,
    progress,
    resolve,
    ledger,
    cursors,
    setPendingLeave: (value: boolean) => { pendingLeave = value; },
    setResolveHook: (hook: typeof resolveHook) => { resolveHook = hook; },
  };
}

describe('eligiblePlaytimeBuckets', () => {
  it('zaehlt nur volle 10-Minuten-Intervalle nach dem Link', () => {
    expect(eligiblePlaytimeBuckets(session({ connectedAt: new Date('2026-08-16T11:55:00Z'), disconnectedAt: new Date('2026-08-16T12:05:00Z') }), LINK_AT, NOW)).toBe(0);
    expect(eligiblePlaytimeBuckets(session({ connectedAt: new Date('2026-08-16T11:55:00Z'), disconnectedAt: new Date('2026-08-16T12:15:00Z') }), LINK_AT, NOW)).toBe(1);
  });

  it('behandelt CLOSED ohne Disconnect konservativ und kappt Zukunft auf now', () => {
    expect(eligiblePlaytimeBuckets(session({ disconnectedAt: null, status: 'CLOSED' }), LINK_AT, NOW)).toBe(0);
    expect(eligiblePlaytimeBuckets(session({ disconnectedAt: new Date('2026-08-16T13:00:00Z') }), LINK_AT, new Date('2026-08-16T12:15:00Z'))).toBe(1);
  });

  it('OPEN verwendet now und ignoriert stale Disconnect', () => {
    expect(eligiblePlaytimeBuckets(session({ disconnectedAt: new Date('2026-08-16T12:05:00Z'), status: 'OPEN' }), LINK_AT, NOW)).toBe(2);
  });
});

describe('bookPlaytimeRewards lifecycle-safe', () => {
  it('zahlt vor dem Link beendete Zeit nie nach', async () => {
    const state = makeClient([session({ connectedAt: new Date('2026-08-16T09:00:00Z'), disconnectedAt: new Date('2026-08-16T11:00:00Z') })], { p1: link() });
    expect((await bookPlaytimeRewards(state.client, SCOPE, { perBucketAmount: 100n, rewardTarget: 'WALLET', now: NOW }, state.resolve)).credited).toBe(0);
    expect(state.accounts.size).toBe(0);
  });

  it('zahlt OPEN nur volle Buckets ab Cutoff und niemals doppelt', async () => {
    const state = makeClient([session({ connectedAt: new Date('2026-08-16T11:55:00Z'), disconnectedAt: null, status: 'OPEN' })], { p1: link() });
    const first = await bookPlaytimeRewards(state.client, SCOPE, { perBucketAmount: 100n, rewardTarget: 'WALLET', now: NOW }, state.resolve);
    const second = await bookPlaytimeRewards(state.client, SCOPE, { perBucketAmount: 100n, rewardTarget: 'WALLET', now: NOW }, state.resolve);
    expect(first.credited).toBe(2);
    expect(second.credited).toBe(0);
    expect(state.accounts.get(`${GUILD}:n:${USER}`)!.walletBalance).toBe(200n);
  });

  it('konsumiert deaktivierte und Betrag-0-Buckets ohne spaeteren Backpay', async () => {
    const s = session({ disconnectedAt: null, status: 'OPEN' });
    const state = makeClient([s], { p1: link() });
    await bookPlaytimeRewards(state.client, SCOPE, { perBucketAmount: 100n, rewardTarget: 'WALLET', payoutEnabled: false, now: NOW }, state.resolve);
    expect(state.progress.get(`s1:${LINK_AT.getTime()}`)?.bucketsCredited).toBe(2);
    const enabled = await bookPlaytimeRewards(state.client, SCOPE, { perBucketAmount: 100n, rewardTarget: 'WALLET', now: new Date('2026-08-16T12:30:00Z') }, state.resolve);
    expect(enabled.credited).toBe(1);
    expect(state.accounts.get(`${GUILD}:n:${USER}`)!.walletBalance).toBe(100n);

    const zero = makeClient([s], { p1: link() });
    await bookPlaytimeRewards(zero.client, SCOPE, { perBucketAmount: 0n, rewardTarget: 'WALLET', now: NOW }, zero.resolve);
    expect(zero.progress.get(`s1:${LINK_AT.getTime()}`)?.bucketsCredited).toBe(2);
  });

  it('blockiert stale Link-Snapshot bei offenem Leave und erzeugt keinen State neu', async () => {
    const state = makeClient([session()], { p1: link() });
    state.setPendingLeave(true);
    const result = await bookPlaytimeRewards(state.client, SCOPE, { perBucketAmount: 100n, rewardTarget: 'WALLET', now: NOW }, state.resolve);
    expect(result).toEqual({ credited: 0, total: 0n });
    expect(state.ledger.size).toBe(0);
    expect(state.accounts.size).toBe(0);
    expect(state.progress.size).toBe(0);
  });

  it('verwirft stale Relink-Identity/Epoche nach der Resolver-Lesung', async () => {
    const links = { p1: link() };
    const state = makeClient([session()], links);
    state.setResolveHook(() => {
      links.p1 = link({ rewardEligibleFrom: new Date('2026-08-16T12:05:00Z'), identityHash: HASH_2 });
      state.setResolveHook(null);
    });
    const result = await bookPlaytimeRewards(state.client, SCOPE, { perBucketAmount: 100n, rewardTarget: 'WALLET', now: NOW }, state.resolve);
    expect(result.credited).toBe(0);
    expect(state.accounts.size).toBe(0);
    expect(state.progress.size).toBe(0);
  });

  it('parallel laufende disabled Worker koennen Progress nicht rueckwaerts setzen', async () => {
    const state = makeClient([session({ disconnectedAt: null, status: 'OPEN' })], { p1: link() });
    await Promise.all([
      bookPlaytimeRewards(state.client, SCOPE, { perBucketAmount: 100n, rewardTarget: 'WALLET', payoutEnabled: false, now: new Date('2026-08-16T12:30:00Z') }, state.resolve),
      bookPlaytimeRewards(state.client, SCOPE, { perBucketAmount: 100n, rewardTarget: 'WALLET', payoutEnabled: false, now: NOW }, state.resolve),
    ]);
    expect(state.progress.get(`s1:${LINK_AT.getTime()}`)?.bucketsCredited).toBe(3);
  });

  it('Relink startet nur in der neuen Epoche neue Buckets', async () => {
    const links = { p1: link() };
    const state = makeClient([session({ connectedAt: new Date('2026-08-16T11:50:00Z'), disconnectedAt: null, status: 'OPEN' })], links);
    await bookPlaytimeRewards(state.client, SCOPE, { perBucketAmount: 100n, rewardTarget: 'WALLET', now: new Date('2026-08-16T12:10:00Z') }, state.resolve);
    links.p1 = link({ rewardEligibleFrom: new Date('2026-08-16T12:12:00Z'), identityHash: HASH_2 });
    await bookPlaytimeRewards(state.client, SCOPE, { perBucketAmount: 100n, rewardTarget: 'WALLET', now: new Date('2026-08-16T12:22:00Z') }, state.resolve);
    expect(state.accounts.get(`${GUILD}:n:${USER}`)!.walletBalance).toBe(200n);
  });

  it('arbeitet mehr als 500 CLOSED-Sessions ohne Starvation ab', async () => {
    const closed = Array.from({ length: 1_205 }, (_, index) => session({
      id: `s-${String(index).padStart(5, '0')}`,
      connectedAt: LINK_AT,
      disconnectedAt: new Date(LINK_AT.getTime() + 10 * 60_000),
      createdAt: new Date(LINK_AT.getTime() + index * 1_000),
      updatedAt: new Date(LINK_AT.getTime() + 10 * 60_000 + index * 1_000),
    }));
    const state = makeClient(closed, { p1: link() });
    const result = await bookPlaytimeRewards(state.client, SCOPE, {
      perBucketAmount: 1n,
      rewardTarget: 'WALLET',
      limit: 200,
      maxClosedPages: 20,
      now: new Date('2026-08-17T00:00:00Z'),
    }, state.resolve);
    expect(result.credited).toBe(1_205);
    expect(state.accounts.get(`${GUILD}:n:${USER}`)!.walletBalance).toBe(1_205n);
  });
});
