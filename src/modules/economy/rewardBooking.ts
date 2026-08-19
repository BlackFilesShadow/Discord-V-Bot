/**
 * RewardBooking (Phase 5) — produktive Buchung offener RewardDecisions.
 *
 * PENDING -> PAID und Geldbuchung sind eine einzige fachliche Transaktion.
 * Parallelworker claimen dieselbe Decision deshalb nie doppelt; ein laufender
 * oder gerade enqueueter Leave-Cleanup wird ueber exakt denselben per-User
 * Advisory-Key wie die Leave-Saga serialisiert und blockiert die Auszahlung.
 *
 * Legacy-Recovery: Vor dieser Haertung konnte Ledger-Commit und PAID-Markierung
 * in zwei Transaktionen auseinanderfallen. Ein exakt passender vorhandener
 * `reward:<decisionId>`-Ledger-Eintrag wird deshalb als bereits gebuchter
 * Commit anerkannt und die Decision ohne zweite Geldmutation auf PAID gehoben.
 * Abweichende Ledger-Daten failen geschlossen.
 *
 * Diese Schicht bucht ECHTES Geld — der Aufrufer MUSS vorher pruefen, dass das
 * Slot-Gate (admRewardsActive) aktiv ist.
 */

import { bookLedgerEntryInTx, type LedgerClient, type LedgerTx } from './ledger';
import { leaveCleanupJobKey } from '../moderation/leaveCleanupSaga';

export interface PendingRewardRow {
  id: string;
  userDiscordId: string;
  calculated: bigint;
}

interface ExistingRewardLedgerRow {
  id: string;
  guildId: string;
  nitradoConnId: string;
  userDiscordId: string;
  walletDelta: bigint;
  bankDelta: bigint;
  type: string;
  sourceRef: string | null;
}

interface RewardBookingTx extends LedgerTx {
  $queryRawUnsafe: <T = unknown>(query: string, ...values: unknown[]) => Promise<T>;
  dataDeletionRequest: {
    findFirst: (args: unknown) => Promise<{ id: string } | null>;
  };
  economyLedgerEntry: LedgerTx['economyLedgerEntry'] & {
    findUnique: (args: unknown) => Promise<ExistingRewardLedgerRow | null>;
  };
  rewardDecision: {
    updateMany: (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => Promise<{ count: number }>;
    update: (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => Promise<unknown>;
  };
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

function expectedDeltas(amount: bigint, target: 'WALLET' | 'BANK'): { walletDelta: bigint; bankDelta: bigint } {
  return target === 'BANK'
    ? { walletDelta: 0n, bankDelta: amount }
    : { walletDelta: amount, bankDelta: 0n };
}

function assertMatchingLegacyLedger(
  row: ExistingRewardLedgerRow,
  expected: {
    guildId: string;
    nitradoConnId: string;
    userDiscordId: string;
    walletDelta: bigint;
    bankDelta: bigint;
    sourceRef: string;
  },
): void {
  const matches = row.guildId === expected.guildId
    && row.nitradoConnId === expected.nitradoConnId
    && row.userDiscordId === expected.userDiscordId
    && row.walletDelta === expected.walletDelta
    && row.bankDelta === expected.bankDelta
    && row.type === 'GRANT'
    && row.sourceRef === expected.sourceRef;
  if (!matches) {
    throw new Error(`Reward-Ledger-Recovery fuer ${expected.sourceRef} ist inkonsistent.`);
  }
}

async function finalizePendingReward(
  client: RewardBookingClient,
  scope: RewardBookingScope,
  decision: PendingRewardRow,
  rewardTarget: 'WALLET' | 'BANK',
): Promise<boolean> {
  return client.$transaction(async (rawTx) => {
    const tx = rawTx as RewardBookingTx;
    const leaveKey = leaveCleanupJobKey(scope.guildId, decision.userDiscordId);

    // Exakt derselbe transaction-scoped Key wie beim Leave-Enqueue. Dadurch gilt:
    // - Reward gewinnt zuerst -> Enqueue wartet; spaeterer Cleanup entfernt ihn.
    // - Enqueue gewinnt zuerst -> Reward sieht den offenen Request und bucht nie.
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
    if (pendingLeave) return false;

    // CAS-Claim auf exakt dem Snapshot, der ausserhalb der Transaktion gelesen
    // wurde. Ein paralleler Reward-Worker oder Leave-Cleanup kann damit keine
    // stale PENDING-Entscheidung spaeter wieder auf PAID ueberschreiben.
    const claim = await tx.rewardDecision.updateMany({
      where: {
        id: decision.id,
        guildId: scope.guildId,
        nitradoConnId: scope.nitradoConnId,
        userDiscordId: decision.userDiscordId,
        calculated: decision.calculated,
        status: 'PENDING',
      },
      data: { status: 'REVIEW' },
    });
    if (claim.count !== 1) return false;

    const key = `reward:${decision.id}`;
    const { walletDelta, bankDelta } = expectedDeltas(decision.calculated, rewardTarget);
    const existing = await tx.economyLedgerEntry.findUnique({
      where: { idempotencyKey: key },
      select: {
        id: true,
        guildId: true,
        nitradoConnId: true,
        userDiscordId: true,
        walletDelta: true,
        bankDelta: true,
        type: true,
        sourceRef: true,
      },
    });

    let ledgerEntryId: string;
    if (existing) {
      assertMatchingLegacyLedger(existing, {
        guildId: scope.guildId,
        nitradoConnId: scope.nitradoConnId,
        userDiscordId: decision.userDiscordId,
        walletDelta,
        bankDelta,
        sourceRef: decision.id,
      });
      ledgerEntryId = existing.id;
    } else {
      const booked = await bookLedgerEntryInTx(tx, {
        idempotencyKey: key,
        guildId: scope.guildId,
        nitradoConnId: scope.nitradoConnId,
        userDiscordId: decision.userDiscordId,
        walletDelta,
        bankDelta,
        type: 'GRANT',
        reason: 'ADM-Reward',
        sourceRef: decision.id,
      });
      ledgerEntryId = booked.entryId;
    }

    await tx.rewardDecision.update({
      where: { id: decision.id },
      data: {
        status: 'PAID',
        paid: decision.calculated,
        ledgerEntryId,
      },
    });
    return true;
  });
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
  for (const decision of pending) {
    if (await finalizePendingReward(client, scope, decision, opts.rewardTarget)) {
      paid++;
      totalAmount += decision.calculated;
    }
  }
  return { paid, totalAmount };
}
