/**
 * PlaytimeBooking (Phase 5) — produktive Spielzeit-Rewards.
 *
 * Schreibt fuer neu erreichte 10-Min-Buckets einer PlayerSession Coins gut und
 * hebt `bucketsCredited` auf `bucketsEarned` an. Idempotent ueber den Ledger-Key
 * `playtime:<sessionId>:<bucketsEarned>` — dieselbe Bucket-Stufe zahlt nie
 * doppelt. Unverlinkte Spieler werden uebersprungen (Buckets bleiben offen und
 * werden nach dem Verlinken nachtraeglich gutgeschrieben).
 *
 * Bucht ECHTES Geld — der Aufrufer MUSS das Slot-Gate (admRewardsActive) pruefen.
 */

import { bookLedgerEntry, type LedgerClient } from './ledger';

export interface UncreditedSession {
  id: string;
  gameId: string;
  bucketsEarned: number;
  bucketsCredited: number;
}

export interface PlaytimeBookingClient extends LedgerClient {
  playerSession: {
    findMany: (args: unknown) => Promise<UncreditedSession[]>;
    update: (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => Promise<unknown>;
  };
  economyLink: {
    findUnique: (args: unknown) => Promise<{ userDiscordId: string } | null>;
  };
}

export interface PlaytimeBookingScope {
  guildId: string;
  nitradoConnId: string;
}

export async function bookPlaytimeRewards(
  client: PlaytimeBookingClient,
  scope: PlaytimeBookingScope,
  opts: { perBucketAmount: bigint; rewardTarget: 'WALLET' | 'BANK'; limit?: number },
): Promise<{ credited: number; total: bigint }> {
  if (opts.perBucketAmount <= 0n) return { credited: 0, total: 0n };

  const sessions = await client.playerSession.findMany({
    where: { guildId: scope.guildId, nitradoConnId: scope.nitradoConnId, bucketsEarned: { gt: 0 } },
    orderBy: { updatedAt: 'desc' },
    take: opts.limit ?? 500,
  });

  let credited = 0;
  let total = 0n;
  for (const s of sessions) {
    const newBuckets = s.bucketsEarned - s.bucketsCredited;
    if (newBuckets <= 0) continue;

    const link = await client.economyLink.findUnique({
      where: { guildId_nitradoConnId_gameId: { guildId: scope.guildId, nitradoConnId: scope.nitradoConnId, gameId: s.gameId } },
    });
    if (!link) continue; // unverlinkt -> Buckets bleiben offen fuer spaeter

    const amount = opts.perBucketAmount * BigInt(newBuckets);
    const walletDelta = opts.rewardTarget === 'BANK' ? 0n : amount;
    const bankDelta = opts.rewardTarget === 'BANK' ? amount : 0n;
    const res = await bookLedgerEntry(client, {
      idempotencyKey: `playtime:${s.id}:${s.bucketsEarned}`,
      guildId: scope.guildId,
      nitradoConnId: scope.nitradoConnId,
      userDiscordId: link.userDiscordId,
      walletDelta,
      bankDelta,
      buckets: newBuckets,
      type: 'PLAYTIME_REWARD',
      reason: 'Spielzeit-Belohnung',
      sourceRef: s.id,
    });
    await client.playerSession.update({ where: { id: s.id }, data: { bucketsCredited: s.bucketsEarned } });
    if (res.booked) { credited++; total += amount; }
  }
  return { credited, total };
}
