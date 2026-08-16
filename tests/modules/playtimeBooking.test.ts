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
  const cursors = new Map<string, { lastTimestamp: Date; lastEntityId: string }>();

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
      findMany: async (args: unknown) => {
        const a = args as { where: { status?: 'OPEN' | 'CLOSED'; OR?: Array<Record<string, unknown>> }; take?: number };
        let rows = sessions.filter(s => !a.where.status || s.status === a.where.status);
        if (a.where.OR) {
          const first = a.where.OR[0] as { updatedAt?: { gt?: Date } };
          const second = a.where.OR[1] as { updatedAt?: Date; id?: { gt?: string } };
          const ts = first.updatedAt?.gt ?? new Date(0);
          const id = second.id?.gt ?? '';
          rows = rows.filter(s => s.updatedAt > ts || (s.updatedAt.getTime() === ts.getTime() && s.id > id));
        }
        rows = [...rows].sort((aRow, bRow) => {
          const aTs = a.where.status === 'CLOSED' ? aRow.updatedAt : aRow.createdAt;
          const bTs = a.where.status === 'CLOSED' ? bRow.updatedAt : bRow.createdAt;
          return aTs.getTime() - bTs.getTime() || aRow.id.localeCompare(bRow.id);
        });
        return rows.slice(0, a.take ?? rows.length).map(s => ({ ...s }));
      },
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

  const resolve = async (gameId: string): Promise<RewardLinkResolution | null> => links[gameId] ?? null;
  return { client, accounts, progress, resolve, ledgerKeys, cursors };
}

const SCOPE = { guildId: 'g', nitradoConnId: 'n' };
const LINK_AT = new Date('2026-08-16T12:00:00.000Z');
const NOW = new Date('2026-08-16T12:20:00.000Z');

function session(overrides: Partial<UncreditedSession> = {}): UncreditedSession {
  const has = (key: keyof UncreditedSession) => Object.prototype.hasOwnProperty.call(overrides, key);
  const connectedAt = has('connectedAt') ? (overrides.connectedAt ?? null) : new Date('2026-08-16T12:00:00.000Z');
  const disconnectedAt = has('disconnectedAt') ? (overrides.disconnectedAt ?? null) : new Date('2026-08-16T12:20:00.000Z');
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

  it('laesst eine CLOSED-Session ohne Disconnect-Zeit nicht weiterlaufen', () => {
    expect(eligiblePlaytimeBuckets(session({ connectedAt: LINK_AT, disconnectedAt: null, status: 'CLOSED' }), LINK_AT, NOW)).toBe(0);
  });

  it('kappt eine zukuenftige Disconnect-Zeit auf now', () => {
    expect(eligiblePlaytimeBuckets(session({
      connectedAt: LINK_AT,
      disconnectedAt: new Date('2026-08-16T13:00:00.000Z'),
      status: 'CLOSED',
    }), LINK_AT, new Date('2026-08-16T12:15:00.000Z'))).toBe(1);
  });

  it('OPEN verwendet now und ignoriert eine stale Disconnect-Zeit', () => {
    expect(eligiblePlaytimeBuckets(session({
      connectedAt: LINK_AT,
      disconnectedAt: new Date('2026-08-16T12:05:00.000Z'),
      status: 'OPEN',
    }), LINK_AT, NOW)).toBe(2);
  });
});

describe('bookPlaytimeRewards ohne Backpay', () => {
  it('zahlt eine komplett vor dem Link beendete Session niemals nachtraeglich', async () => {
    const { client, accounts, resolve } = makeClient([
      session({ connectedAt: new Date('2026-08-16T09:00:00.000Z'), disconnectedAt: new Date('2026-08-16T11:00:00.000Z') }),
    ], { p1: { userDiscordId: 'u1', rewardEligibleFrom: LINK_AT } });
    const result = await bookPlaytimeRewards(client, SCOPE, { perBucketAmount: 100n, rewardTarget: 'WALLET', now: NOW }, resolve);
    expect(result.credited).toBe(0);
    expect(accounts.get('g:n:u1')).toBeUndefined();
  });

  it('zahlt bei einer laufenden Session nur volle Zeit ab dem Link-Cutoff', async () => {
    const { client, accounts, resolve } = makeClient([
      session({ connectedAt: new Date('2026-08-16T11:55:00.000Z'), disconnectedAt: null, status: 'OPEN' }),
    ], { p1: { userDiscordId: 'u1', rewardEligibleFrom: LINK_AT } });
    const result = await bookPlaytimeRewards(client, SCOPE, { perBucketAmount: 100n, rewardTarget: 'WALLET', now: NOW }, resolve);
    expect(result.credited).toBe(2);
    expect(accounts.get('g:n:u1')!.walletBalance.toString()).toBe('200');
  });

  it('zweiter Lauf derselben Link-Epoche zahlt keinen Bucket doppelt', async () => {
    const { client, accounts, resolve } = makeClient([session()], { p1: { userDiscordId: 'u1', rewardEligibleFrom: LINK_AT } });
    await bookPlaytimeRewards(client, SCOPE, { perBucketAmount: 100n, rewardTarget: 'WALLET', now: NOW }, resolve);
    const second = await bookPlaytimeRewards(client, SCOPE, { perBucketAmount: 100n, rewardTarget: 'WALLET', now: NOW }, resolve);
    expect(second.credited).toBe(0);
    expect(accounts.get('g:n:u1')!.walletBalance.toString()).toBe('200');
  });

  it('unverlinkter Spieler bleibt ohne Auszahlung', async () => {
    const { client, accounts, resolve } = makeClient([session()], {});
    const result = await bookPlaytimeRewards(client, SCOPE, { perBucketAmount: 100n, rewardTarget: 'WALLET', now: NOW }, resolve);
    expect(result.credited).toBe(0);
    expect(accounts.size).toBe(0);
  });

  it('konsumiert deaktivierte Zeit-Buckets und zahlt sie nach Aktivierung nicht nach', async () => {
    const s = session({ connectedAt: LINK_AT, disconnectedAt: null, status: 'OPEN' });
    const { client, accounts, progress, resolve } = makeClient([s], { p1: { userDiscordId: 'u1', rewardEligibleFrom: LINK_AT } });
    await bookPlaytimeRewards(client, SCOPE, { perBucketAmount: 100n, rewardTarget: 'WALLET', payoutEnabled: false, now: NOW }, resolve);
    expect(progress.get(`s1:${LINK_AT.getTime()}`)).toBe(2);
    const enabled = await bookPlaytimeRewards(client, SCOPE, { perBucketAmount: 100n, rewardTarget: 'WALLET', payoutEnabled: true, now: new Date('2026-08-16T12:30:00.000Z') }, resolve);
    expect(enabled.credited).toBe(1);
    expect(accounts.get('g:n:u1')!.walletBalance.toString()).toBe('100');
  });

  it('konsumiert auch Betrag-0-Buckets statt sie spaeter nachzuzahlen', async () => {
    const s = session({ connectedAt: LINK_AT, disconnectedAt: null, status: 'OPEN' });
    const { client, progress, resolve } = makeClient([s], { p1: { userDiscordId: 'u1', rewardEligibleFrom: LINK_AT } });
    await bookPlaytimeRewards(client, SCOPE, { perBucketAmount: 0n, rewardTarget: 'WALLET', now: NOW }, resolve);
    expect(progress.get(`s1:${LINK_AT.getTime()}`)).toBe(2);
  });

  it('eine neue Relink-Epoche beginnt mathematisch wieder bei deren Zeitpunkt', async () => {
    const s = session({ connectedAt: new Date('2026-08-16T11:50:00.000Z'), disconnectedAt: null, status: 'OPEN' });
    const links: Record<string, RewardLinkResolution> = { p1: { userDiscordId: 'u1', rewardEligibleFrom: LINK_AT } };
    const { client, accounts, resolve } = makeClient([s], links);
    await bookPlaytimeRewards(client, SCOPE, { perBucketAmount: 100n, rewardTarget: 'WALLET', now: new Date('2026-08-16T12:10:00.000Z') }, resolve);
    links.p1 = { userDiscordId: 'u1', rewardEligibleFrom: new Date('2026-08-16T12:12:00.000Z') };
    await bookPlaytimeRewards(client, SCOPE, { perBucketAmount: 100n, rewardTarget: 'WALLET', now: new Date('2026-08-16T12:22:00.000Z') }, resolve);
    expect(accounts.get('g:n:u1')!.walletBalance.toString()).toBe('200');
  });

  it('arbeitet mehr als 500 CLOSED-Sessions ueber mehrere Seiten vollstaendig ab', async () => {
    const closed = Array.from({ length: 1_205 }, (_, index) => session({
      id: `s-${String(index).padStart(5, '0')}`,
      gameId: 'p1',
      connectedAt: LINK_AT,
      disconnectedAt: new Date(LINK_AT.getTime() + 10 * 60_000),
      createdAt: new Date(LINK_AT.getTime() + index * 1_000),
      updatedAt: new Date(LINK_AT.getTime() + 10 * 60_000 + index * 1_000),
      status: 'CLOSED',
    }));
    const { client, accounts, resolve } = makeClient(closed, { p1: { userDiscordId: 'u1', rewardEligibleFrom: LINK_AT } });
    const result = await bookPlaytimeRewards(client, SCOPE, {
      perBucketAmount: 1n,
      rewardTarget: 'WALLET',
      limit: 200,
      maxClosedPages: 20,
      now: new Date('2026-08-17T00:00:00.000Z'),
    }, resolve);
    expect(result.credited).toBe(1_205);
    expect(accounts.get('g:n:u1')!.walletBalance.toString()).toBe('1205');
  });
});
