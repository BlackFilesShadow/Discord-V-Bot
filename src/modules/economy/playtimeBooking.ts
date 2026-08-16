/**
 * Produktive Spielzeit-Rewards ab Account-Verknuepfung.
 *
 * Historische/unverlinkte Spielzeit wird niemals nachbezahlt. Fuer jede aktive
 * Link-Epoche wird die rewardfaehige Dauer exakt ab `rewardEligibleFrom`
 * berechnet. Vollstaendige 10-Minuten-Intervalle werden einzeln ueber stabile
 * Ledger-Keys gebucht; PlaytimeRewardProgress vermeidet dabei unnoetige
 * Wiederholungen und ein erneuter Link startet eine neue Epoche.
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

export function eligiblePlaytimeBuckets(
  session: Pick<UncreditedSession, 'connectedAt' | 'disconnectedAt'>,
  rewardEligibleFrom: Date,
  now: Date = new Date(),
): number {
  if (!session.connectedAt) return 0;
  const startMs = Math.max(session.connectedAt.getTime(), rewardEligibleFrom.getTime());
  const endMs = (session.disconnectedAt ?? now).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return 0;
  return Math.floor((endMs - startMs) / 1000 / REWARD_BUCKET_SECONDS);
}

export async function bookPlaytimeRewards(
  client: PlaytimeBookingClient,
  scope: PlaytimeBookingScope,
  opts: { perBucketAmount: bigint; rewardTarget: 'WALLET' | 'BANK'; limit?: number; now?: Date },
  resolveRewardLink: ResolveRewardLinkFn,
): Promise<{ credited: number; total: bigint }> {
  if (opts.perBucketAmount <= 0n) return { credited: 0, total: 0n };
  const now = opts.now ?? new Date();

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
    const alreadyCredited = Math.max(0, progress?.bucketsCredited ?? 0);
    if (eligibleBuckets <= alreadyCredited) continue;

    let highestProcessed = alreadyCredited;
    for (let bucket = alreadyCredited + 1; bucket <= eligibleBuckets; bucket++) {
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

    await client.playtimeRewardProgress.upsert({
      where: {
        sessionId_rewardEpoch: {
          sessionId: session.id,
          rewardEpoch: link.rewardEligibleFrom,
        },
      },
      create: {
        sessionId: session.id,
        guildId: scope.guildId,
        nitradoConnId: scope.nitradoConnId,
        userDiscordId: link.userDiscordId,
        rewardEpoch: link.rewardEligibleFrom,
        bucketsCredited: highestProcessed,
      },
      update: {
        userDiscordId: link.userDiscordId,
        bucketsCredited: highestProcessed,
      },
    });
  }
  return { credited, total };
}
