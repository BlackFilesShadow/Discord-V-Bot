/**
 * RewardBooking (Phase 5) — produktive Buchung offener RewardDecisions.
 *
 * Hebt PENDING-RewardDecisions mit Betrag > 0 auf PAID an und bucht den Betrag
 * ueber `bookLedgerEntry`. Idempotent auf zwei Ebenen: der Ledger-Key
 * `reward:<decisionId>` verhindert Doppelbuchung, und bereits gebuchte
 * Decisions werden anschliessend als PAID markiert (Recovery nach Teilfehlern).
 *
 * Diese Schicht bucht ECHTES Geld — der Aufrufer MUSS vorher pruefen, dass das
 * Slot-Gate (admRewardsActive) aktiv ist.
 */

import { bookLedgerEntry, type LedgerClient } from './ledger';

export interface PendingRewardRow {
  id: string;
  userDiscordId: string;
  calculated: bigint;
}

export interface RewardBookingClient extends LedgerClient {
  rewardDecision: {
    findMany: (args: unknown) => Promise<PendingRewardRow[]>;
    update: (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => Promise<unknown>;
  };
}

export interface RewardBookingScope {
  guildId: string;
  nitradoConnId: string;
}

export async function bookPendingRewards(
  client: RewardBookingClient,
  scope: RewardBookingScope,
  opts: { rewardTarget: 'WALLET' | 'BANK'; limit?: number },
): Promise<{ paid: number; totalAmount: bigint }> {
  const pending = await client.rewardDecision.findMany({
    where: {
      guildId: scope.guildId,
      nitradoConnId: scope.nitradoConnId,
      status: 'PENDING',
      userDiscordId: { not: null },
      calculated: { gt: 0 },
    },
    orderBy: { createdAt: 'asc' },
    take: opts.limit ?? 500,
  });

  let paid = 0;
  let totalAmount = 0n;
  for (const d of pending) {
    const walletDelta = opts.rewardTarget === 'BANK' ? 0n : d.calculated;
    const bankDelta = opts.rewardTarget === 'BANK' ? d.calculated : 0n;
    const res = await bookLedgerEntry(client, {
      idempotencyKey: `reward:${d.id}`,
      guildId: scope.guildId,
      nitradoConnId: scope.nitradoConnId,
      userDiscordId: d.userDiscordId,
      walletDelta,
      bankDelta,
      type: 'GRANT',
      reason: 'ADM-Reward',
      sourceRef: d.id,
    });
    await client.rewardDecision.update({
      where: { id: d.id },
      data: { status: 'PAID', paid: d.calculated, ...(res.entryId ? { ledgerEntryId: res.entryId } : {}) },
    });
    paid++;
    totalAmount += d.calculated;
  }
  return { paid, totalAmount };
}
