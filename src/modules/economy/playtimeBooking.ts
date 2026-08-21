/* eslint-disable local/no-unscoped-prisma-query -- Stage 64: guild boundary enforced at auth/API or entity-id unique after prior guild check; Prisma update/delete require unique where. */
/**
 * Produktive Spielzeit-Rewards ab Account-Verknuepfung.
 *
 * Historische/unverlinkte Spielzeit wird niemals nachbezahlt. Fuer jede aktive
 * Link-Epoche wird die rewardfaehige Dauer exakt ab `rewardEligibleFrom`
 * berechnet. Vollstaendige 10-Minuten-Intervalle werden einzeln ueber stabile
 * Ledger-Keys gebucht.
 *
 * NIT/Economy-Haertung: Link-Snapshot, Leave-Lifecycle, Ledger-Buckets und
 * PlaytimeRewardProgress werden pro Session in einer gemeinsamen Transaktion
 * gefenced. Der transaction-scoped User-Advisory-Key ist derselbe wie beim
 * Leave-Enqueue; der Reward-State wird zusaetzlich `FOR UPDATE` auf exakte
 * Identity+Reward-Epoche revalidiert. So kann ein stale Worker nach Leave,
 * Unlink oder Relink weder Geld noch rohen Progress neu erzeugen.
 *
 * OPEN-Sessions werden bei jedem Lauf vollstaendig ausgewertet. CLOSED-Sessions
 * laufen ueber einen persistenten High-Watermark, damit grosse Backlogs nicht
 * hinter einem festen Batch-Fenster verhungern.
 */

import { bookLedgerEntryInTx, type LedgerClient, type LedgerTx } from './ledger';
import {
  advanceRewardCursor,
  afterCursorWhere,
  getRewardCursor,
  type RewardCursorClient,
} from './rewardCursor';
import { leaveCleanupJobKey } from '../moderation/leaveCleanupSaga';

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

interface ExistingPlaytimeLedgerRow {
  id: string;
  guildId: string;
  nitradoConnId: string;
  userDiscordId: string;
  type: string;
  buckets: number;
  sourceRef: string | null;
}

interface LockedRewardStateRow {
  identityHash: string;
  rewardEligibleFrom: Date;
  unlinkedAt: Date | null;
}

interface PlaytimeBookingTx extends LedgerTx {
  $queryRawUnsafe: <T = unknown>(query: string, ...values: unknown[]) => Promise<T>;
  dataDeletionRequest: {
    findFirst: (args: unknown) => Promise<{ id: string } | null>;
  };
  economyLedgerEntry: LedgerTx['economyLedgerEntry'] & {
    findUnique: (args: unknown) => Promise<ExistingPlaytimeLedgerRow | null>;
  };
  playtimeRewardProgress: {
    findUnique: (args: unknown) => Promise<PlaytimeRewardProgressRow | null>;
    upsert: (args: { where: Record<string, unknown>; create: Record<string, unknown>; update: Record<string, unknown> }) => Promise<unknown>;
  };
}

export interface PlaytimeBookingClient extends LedgerClient, RewardCursorClient {
  playerSession: {
    findMany: (args: unknown) => Promise<UncreditedSession[]>;
  };
}

export interface RewardLinkResolution {
  userDiscordId: string;
  rewardEligibleFrom: Date;
  identityHash: string;
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

function assertMatchingHistoricalBucket(
  row: ExistingPlaytimeLedgerRow,
  expected: { guildId: string; nitradoConnId: string; userDiscordId: string; sourceRef: string },
): void {
  const matches = row.guildId === expected.guildId
    && row.nitradoConnId === expected.nitradoConnId
    && row.userDiscordId === expected.userDiscordId
    && row.type === 'PLAYTIME_REWARD'
    && row.buckets === 1
    && row.sourceRef === expected.sourceRef;
  if (!matches) throw new Error(`Playtime-Ledger-Recovery fuer ${expected.sourceRef} ist inkonsistent.`);
}

async function persistProgress(
  tx: PlaytimeBookingTx,
  scope: PlaytimeBookingScope,
  sessionId: string,
  link: RewardLinkResolution,
  bucketsCredited: number,
): Promise<void> {
  await tx.playtimeRewardProgress.upsert({
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

  return client.$transaction(async (rawTx) => {
    const tx = rawTx as PlaytimeBookingTx;
    const leaveKey = leaveCleanupJobKey(scope.guildId, link.userDiscordId);

    // Serialisiert gegen Leave-Enqueue. Ein bereits enqueueter Reset blockiert
    // jede weitere Money-/Progress-Mutation; ein spaeterer Enqueue wartet bis
    // diese Transaktion committed und kann den gerade geschriebenen State dann
    // in derselben Leave-Saga wieder entfernen/pseudonymisieren.
    await tx.$queryRawUnsafe(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      leaveKey,
    );
    const pendingLeave = await tx.dataDeletionRequest.findFirst({
      where: {
        userId: leaveKey,
        requestType: 'PARTIAL_DELETION',
        status: { in: ['PENDING', 'IN_PROGRESS', 'FAILED'] },
      },
      select: { id: true },
    });
    if (pendingLeave) return { credited: 0, total: 0n };

    // Row-Lock serialisiert gleichzeitig mit Unlink/Relink/Delete desselben
    // Reward-State. Exakte Identity + Epoch verhindern stale Rejoin-Snapshots.
    const stateRows = await tx.$queryRawUnsafe<LockedRewardStateRow[]>(
      `SELECT "identityHash", "rewardEligibleFrom", "unlinkedAt"
         FROM "EconomyLinkRewardState"
        WHERE "guildId"=$1 AND "nitradoConnId"=$2 AND "userDiscordId"=$3
        FOR UPDATE`,
      scope.guildId,
      scope.nitradoConnId,
      link.userDiscordId,
    );
    const current = stateRows[0];
    if (!current
      || current.unlinkedAt !== null
      || current.identityHash !== link.identityHash
      || current.rewardEligibleFrom.getTime() !== link.rewardEligibleFrom.getTime()) {
      return { credited: 0, total: 0n };
    }

    const progress = await tx.playtimeRewardProgress.findUnique({
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
      await persistProgress(tx, scope, session.id, link, eligibleBuckets);
      return { credited: 0, total: 0n };
    }

    let credited = 0;
    let total = 0n;
    for (let bucket = alreadyProcessed + 1; bucket <= eligibleBuckets; bucket++) {
      const amount = opts.perBucketAmount;
      const walletDelta = opts.rewardTarget === 'BANK' ? 0n : amount;
      const bankDelta = opts.rewardTarget === 'BANK' ? amount : 0n;
      const key = `playtime:${session.id}:${link.rewardEligibleFrom.getTime()}:${bucket}`;
      const existing = await tx.economyLedgerEntry.findUnique({
        where: { idempotencyKey: key },
        select: {
          id: true,
          guildId: true,
          nitradoConnId: true,
          userDiscordId: true,
          type: true,
          buckets: true,
          sourceRef: true,
        },
      });
      if (existing) {
        // Betrag/Ziel koennen sich spaeter konfigurationsbedingt aendern. Ein
        // historisch bereits gebuchter Bucket bleibt trotzdem verbraucht; nur
        // Scope/User/Typ/Quelle muessen exakt zur stabilen Bucket-ID passen.
        assertMatchingHistoricalBucket(existing, {
          guildId: scope.guildId,
          nitradoConnId: scope.nitradoConnId,
          userDiscordId: link.userDiscordId,
          sourceRef: session.id,
        });
        continue;
      }

      await bookLedgerEntryInTx(tx, {
        idempotencyKey: key,
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
      credited++;
      total += amount;
    }

    // Unter demselben User-Lock wurde der aktuelle Progress NACH jeder
    // konkurrierenden Transaktion neu gelesen. Der absolute Wert kann daher
    // nicht mehr durch einen langsameren, aelteren Worker zurueckgesetzt werden.
    await persistProgress(tx, scope, session.id, link, eligibleBuckets);
    return { credited, total };
  });
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
