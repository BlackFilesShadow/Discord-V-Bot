/**
 * Produktive Spielzeit-Rewards ab Account-Verknuepfung.
 *
 * Historische/unverlinkte Spielzeit wird niemals nachbezahlt. Fuer jede aktive
 * Link-Epoche wird die rewardfaehige Dauer exakt ab `rewardEligibleFrom`
 * berechnet. Vollstaendige 10-Minuten-Intervalle werden einzeln ueber stabile
 * Ledger-Keys gebucht. PlaytimeRewardProgress ist zugleich der High-Watermark:
 * auch Intervalle, die bei deaktivierten Rewards oder einem Betrag von 0
 * enden, werden konsumiert und koennen spaeter nicht als Backpay auftauchen.
 */

import { bookLedgerEntry, type LedgerClient } from './ledger';

const REWARD_BUCKET_SECONDS = 600;

export interface UncreditedSession {
  id: string;
  gameId: string;
  connectedAt: Date | null;
  disconnectedAt: Date | null;
  status: 'OPEN' | 'CLOSED';
}

export interface PlaytimeRewardProgressRow {
  bucketsCredited: number;
}

export interface PlaytimeBookingClient extends LedgerClient {
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

/**
 * Anzahl vollstaendiger 10-Minuten-Intervalle in der aktuellen Link-Epoche.
 * OPEN benutzt ausschliesslich `now`; CLOSED benoetigt zwingend eine echte
 * Disconnect-Zeit. Eine Zukunftszeit darf niemals vorzeitig Geld erzeugen.
 */
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

export async function bookPlaytimeRewards(
  client: PlaytimeBookingClient,
  scope: PlaytimeBookingScope,
  opts: {
    perBucketAmount: bigint;
    rewardTarget: 'WALLET' | 'BANK';
    limit?: number;
    now?: Date;
    payoutEnabled?: boolean;
  },
  resolveRewardLink: ResolveRewardLinkFn,
): Promise<{ credited: number; total: bigint }> {
  const now = opts.now ?? new Date();
  const payoutEnabled = opts.payoutEnabled !== false && opts.perBucketAmount > 0n;

  const sessions = await client.playerSession.findMany({
    where: {
      guildId: scope.guildId,
      nitradoConnId: scope.nitradoConnId,
      connectedAt: { not: null },
    },
    orderBy: { updatedAt: 'desc' },
    take: opts.limit ?? 500,
  });

  let credited = 0;
  let total = 0n;
  for (const session of sessions) {
    const link = await resolveRewardLink(session.gameId);
    if (!link) continue;

    const eligibleBuckets = eligiblePlaytimeBuckets(session, link.rewardEligibleFrom, now);
    if (eligibleBuckets <= 0) continue;

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
    if (eligibleBuckets <= alreadyProcessed) continue;

    // Ein deaktivierter Reward oder Betrag 0 darf keine spaetere Nachzahlung
    // erzeugen. Die aktuell vollstaendigen Intervalle werden deshalb bewusst
    // als verarbeitet markiert, ohne Ledger-/Account-Buchung.
    if (!payoutEnabled) {
      await persistProgress(client, scope, session.id, link, eligibleBuckets);
      continue;
    }

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
  }
  return { credited, total };
}
