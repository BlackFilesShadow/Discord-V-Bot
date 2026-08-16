/**
 * Produktive Spielzeit-Rewards ab Account-Verknuepfung.
 *
 * Historische/unverlinkte Spielzeit wird niemals nachbezahlt. Fuer jede aktive
 * Link-Epoche wird die rewardfaehige Dauer exakt ab `rewardEligibleFrom`
 * berechnet. Vollstaendige 10-Minuten-Intervalle werden einzeln ueber stabile
 * Ledger-Keys gebucht.
 *
 * OPEN-Sessions werden bei jedem Lauf vollstaendig ausgewertet (ein DayZ-Server
 * hat nur eine begrenzte Zahl gleichzeitig verbundener Spieler). CLOSED-
 * Sessions laufen ueber einen persistenten High-Watermark. Dadurch koennen
 * auch nach sehr langer Laufzeit keine Sessions hinter einem 500er-Fenster
 * dauerhaft verhungern.
 */

import { bookLedgerEntry, type LedgerClient } from './ledger';
import {
  advanceRewardCursor,
  afterCursorWhere,
  getRewardCursor,
  type RewardCursorClient,
} from './rewardCursor';

const REWARD_BUCKET_SECONDS = 600;
const CLOSED_SESSION_STREAM = 'playtime:closed';

export interface UncreditedSession {
  id: string;
  gameId: string;
  connectedAt: Date | null;
  disconnectedAt: Date | null;
  status: 'OPEN' | 'CLOSED';
  createdAt: Date;
  updatedAt: Date;
}

export interface PlaytimeRewardProgressRow {
  bucketsCredited: number;
}

export interface PlaytimeBookingClient extends LedgerClient, RewardCursorClient {
  playerSession: {
    findMany: (args: unknown) => Promise<UncreditedSession[]>;
  };
  playtimeRewardProgress: {
    findUnique: (args: unknown) => Promise<PlaytimeRewardProgressRow | null>;
    upsert: (args: { where: Record<string, unknown>; create: Record<string, unknown>; update: Record<string, unknown> }) => Promise<unknown>;
  };
}

export interface RewardLinkResolution {
  userDiscordId: string;
  rewardEligibleFrom: Date;
}

export type ResolveRewardLinkFn = (gameId: string) => Promise<RewardLinkResolution | null>;

export interface PlaytimeBookingScope {
  guildId: string;
  nitradoConnId: string;
}

/** Anzahl vollstaendiger 10-Minuten-Intervalle in der aktuellen Link-Epoche. */
export function eligiblePlaytimeBuckets(
  session: Pick<UncreditedSession, 'connectedAt' | 'disconnectedAt' | 'status'>,
  rewardEligibleFrom: Date,
  now: Date = new Date(),
): number {
  if (!session.connectedAt) return 0;

  const nowMs = now.getTime();
  const connectedMs = session.connectedAt.getTime();
  const rewardFromMs = rewardEligibleFrom.getTime();
  if (!Number.isFinite(nowMs) || !Number.isFinite(connectedMs) || !Number.isFinite(rewardFromMs)) return 0;

  let endMs: number;
  if (session.status === 'OPEN') {
    endMs = nowMs;
  } else {
    if (!session.disconnectedAt) return 0;
    const disconnectedMs = session.disconnectedAt.getTime();
    if (!Number.isFinite(disconnectedMs)) return 0;
    endMs = Math.min(disconnectedMs, nowMs);
  }

  const startMs = Math.max(connectedMs, rewardFromMs);
  if (endMs <= startMs) return 0;
  return Math.floor((endMs - startMs) / 1000 / REWARD_BUCKET_SECONDS);
}

async function persistProgress(
  client: PlaytimeBookingClient,
  scope: PlaytimeBookingScope,
  sessionId: string,
  link: RewardLinkResolution,
  bucketsCredited: number,
): Promise<void> {
  await client.playtimeRewardProgress.upsert({
    where: {
      sessionId_rewardEpoch: {
        sessionId,
        rewardEpoch: link.rewardEligibleFrom,
      },
    },
    create: {
      sessionId,
      guildId: scope.guildId,
      nitradoConnId: scope.nitradoConnId,
      userDiscordId: link.userDiscordId,
      rewardEpoch: link.rewardEligibleFrom,
      bucketsCredited,
    },
    update: {
      userDiscordId: link.userDiscordId,
      bucketsCredited,
    },
  });
}

async function processSession(
  client: PlaytimeBookingClient,
  scope: PlaytimeBookingScope,
  session: UncreditedSession,
  opts: { perBucketAmount: bigint; rewardTarget: 'WALLET' | 'BANK'; payoutEnabled: boolean; now: Date },
  resolveRewardLink: ResolveRewardLinkFn,
): Promise<{ credited: number; total: bigint }> {
  const link = await resolveRewardLink(session.gameId);
  if (!link) return { credited: 0, total: 0n };

  const eligibleBuckets = eligiblePlaytimeBuckets(session, link.rewardEligibleFrom, opts.now);
  if (eligibleBuckets <= 0) return { credited: 0, total: 0n };

  const progress = await client.playtimeRewardProgress.findUnique({
    where: {
      sessionId_rewardEpoch: {
        sessionId: session.id,
        rewardEpoch: link.rewardEligibleFrom,
      },
    },
    select: { bucketsCredited: true },
  });
  const alreadyProcessed = Math.max(0, progress?.bucketsCredited ?? 0);
  if (eligibleBuckets <= alreadyProcessed) return { credited: 0, total: 0n };

  if (!opts.payoutEnabled) {
    await persistProgress(client, scope, session.id, link, eligibleBuckets);
    return { credited: 0, total: 0n };
  }

  let credited = 0;
  let total = 0n;
  let highestProcessed = alreadyProcessed;
  for (let bucket = alreadyProcessed + 1; bucket <= eligibleBuckets; bucket++) {
    const amount = opts.perBucketAmount;
    const walletDelta = opts.rewardTarget === 'BANK' ? 0n : amount;
    const bankDelta = opts.rewardTarget === 'BANK' ? amount : 0n;
    const result = await bookLedgerEntry(client, {
      idempotencyKey: `playtime:${session.id}:${link.rewardEligibleFrom.getTime()}:${bucket}`,
      guildId: scope.guildId,
      nitradoConnId: scope.nitradoConnId,
      userDiscordId: link.userDiscordId,
      walletDelta,
      bankDelta,
      buckets: 1,
      type: 'PLAYTIME_REWARD',
      reason: 'Spielzeit-Belohnung nach Account-Verknuepfung',
      sourceRef: session.id,
    });
    highestProcessed = bucket;
    if (result.booked) {
      credited++;
      total += amount;
    }
  }

  await persistProgress(client, scope, session.id, link, highestProcessed);
  return { credited, total };
}

export async function bookPlaytimeRewards(
  client: PlaytimeBookingClient,
  scope: PlaytimeBookingScope,
  opts: {
    perBucketAmount: bigint;
    rewardTarget: 'WALLET' | 'BANK';
    limit?: number;
    maxClosedPages?: number;
    now?: Date;
    payoutEnabled?: boolean;
  },
  resolveRewardLink: ResolveRewardLinkFn,
): Promise<{ credited: number; total: bigint }> {
  const now = opts.now ?? new Date();
  const payoutEnabled = opts.payoutEnabled !== false && opts.perBucketAmount > 0n;
  const batchSize = Math.max(1, Math.min(2_000, Math.trunc(opts.limit ?? 500)));
  const maxClosedPages = Math.max(1, Math.min(500, Math.trunc(opts.maxClosedPages ?? 50)));
  let credited = 0;
  let total = 0n;

  // OPEN-Sessions muessen bei jedem Lauf erneut betrachtet werden, weil mit
  // fortschreitender Zeit neue 10-Minuten-Buckets entstehen koennen.
  const openSessions = await client.playerSession.findMany({
    where: {
      guildId: scope.guildId,
      nitradoConnId: scope.nitradoConnId,
      status: 'OPEN',
      connectedAt: { not: null },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  for (const session of openSessions) {
    const result = await processSession(
      client,
      scope,
      session,
      { perBucketAmount: opts.perBucketAmount, rewardTarget: opts.rewardTarget, payoutEnabled, now },
      resolveRewardLink,
    );
    credited += result.credited;
    total += result.total;
  }

  // CLOSED-Sessions sind nach dem Disconnect unveraenderlich genug fuer einen
  // persistenten updatedAt/id-Cursor. Ein spaeter korrigierter Datensatz bekommt
  // ein neues updatedAt und wird dadurch erneut idempotent geprueft.
  let cursor = await getRewardCursor(client, scope, CLOSED_SESSION_STREAM);
  for (let page = 0; page < maxClosedPages; page++) {
    const closedSessions = await client.playerSession.findMany({
      where: {
        guildId: scope.guildId,
        nitradoConnId: scope.nitradoConnId,
        status: 'CLOSED',
        connectedAt: { not: null },
        ...afterCursorWhere(cursor, 'updatedAt'),
      },
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      take: batchSize,
    });
    if (closedSessions.length === 0) break;

    for (const session of closedSessions) {
      const result = await processSession(
        client,
        scope,
        session,
        { perBucketAmount: opts.perBucketAmount, rewardTarget: opts.rewardTarget, payoutEnabled, now },
        resolveRewardLink,
      );
      credited += result.credited;
      total += result.total;
    }

    const last = closedSessions[closedSessions.length - 1];
    const next = { timestamp: last.updatedAt, entityId: last.id };
    await advanceRewardCursor(client, scope, CLOSED_SESSION_STREAM, next);
    cursor = next;
    if (closedSessions.length < batchSize) break;
  }

  return { credited, total };
}
