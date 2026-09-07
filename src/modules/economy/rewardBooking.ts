/* eslint-disable local/no-unscoped-prisma-query -- Stage 64: guild boundary enforced at auth/API or entity-id unique after prior guild check; Prisma update/delete require unique where. */
/**
 * RewardBooking — productive booking of pending RewardDecisions.
 *
 * PENDING -> PAID and the money booking are one transaction. In addition to the
 * existing leave/race fences, V3 enforces EconomyRewardRule.dailyCap and
 * cooldownSeconds at the point where real money would be created.
 */
import { bookLedgerEntryInTx, type LedgerClient, type LedgerTx } from './ledger';
import { leaveCleanupJobKey } from '../moderation/leaveCleanupSaga';

export interface PendingRewardRow {
  id: string;
  userDiscordId: string;
  calculated: bigint;
  rewardRuleId: string;
  createdAt: Date;
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

interface RewardLimitRow {
  paidToday: bigint;
  lastPaidAt: Date | null;
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

export interface RewardBookingPolicy {
  rewardTarget: 'WALLET' | 'BANK';
  dailyCap?: bigint | null;
  cooldownSeconds?: number;
  timezone?: string;
  limit?: number;
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
  if (!matches) throw new Error(`Reward-Ledger-Recovery fuer ${expected.sourceRef} ist inkonsistent.`);
}

function normalizePolicy(policy: RewardBookingPolicy) {
  const dailyCap = policy.dailyCap !== undefined && policy.dailyCap !== null && policy.dailyCap > 0n
    ? policy.dailyCap
    : null;
  const cooldownSeconds = Number.isInteger(policy.cooldownSeconds) && (policy.cooldownSeconds ?? 0) > 0
    ? Math.min(86_400, Math.max(0, policy.cooldownSeconds ?? 0))
    : 0;
  const timezone = typeof policy.timezone === 'string' && policy.timezone.trim() ? policy.timezone.trim() : 'Europe/Berlin';
  return { dailyCap, cooldownSeconds, timezone };
}

async function rewardLimits(
  tx: RewardBookingTx,
  scope: RewardBookingScope,
  decision: PendingRewardRow,
  timezone: string,
): Promise<RewardLimitRow> {
  const rows = await tx.$queryRawUnsafe<RewardLimitRow[]>(
    `SELECT COALESCE(SUM("paid"), 0)::bigint AS "paidToday",
            MAX("createdAt") AS "lastPaidAt"
       FROM "RewardDecision"
      WHERE "guildId"=$1
        AND "nitradoConnId"=$2
        AND "rewardRuleId"=$3
        AND "userDiscordId"=$4
        AND "status"='PAID'::"RewardDecisionStatus"
        AND ("createdAt" AT TIME ZONE $5)::date = ($6::timestamptz AT TIME ZONE $5)::date`,
    scope.guildId,
    scope.nitradoConnId,
    decision.rewardRuleId,
    decision.userDiscordId,
    timezone,
    decision.createdAt,
  );
  return rows[0] ?? { paidToday: 0n, lastPaidAt: null };
}

async function markSkipped(
  tx: RewardBookingTx,
  decisionId: string,
  reasonCode: 'SKIPPED_DAILY_CAP' | 'SKIPPED_COOLDOWN',
): Promise<void> {
  await tx.rewardDecision.update({
    where: { id: decisionId },
    data: { status: 'SKIPPED', paid: 0n, reasonCode, ledgerEntryId: null },
  });
}

/** Returns finalized paid amount, 0n for a handled no-pay outcome, null for CAS/leave loss. */
async function finalizePendingReward(
  client: RewardBookingClient,
  scope: RewardBookingScope,
  decision: PendingRewardRow,
  policy: RewardBookingPolicy,
): Promise<bigint | null> {
  const normalized = normalizePolicy(policy);
  return client.$transaction(async rawTx => {
    const tx = rawTx as RewardBookingTx;
    const leaveKey = leaveCleanupJobKey(scope.guildId, decision.userDiscordId);

    await tx.$queryRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', leaveKey);
    const pendingLeave = await tx.dataDeletionRequest.findFirst({
      where: {
        userId: leaveKey,
        requestType: 'PARTIAL_DELETION',
        status: { in: ['PENDING', 'IN_PROGRESS', 'FAILED'] },
      },
      select: { id: true },
    });
    if (pendingLeave) return null;

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
    if (claim.count !== 1) return null;

    const key = `reward:${decision.id}`;
    // Recovery has priority over newly configured limits: money that already
    // committed must only repair the Decision state, never be mutated again.
    const existing = await tx.economyLedgerEntry.findUnique({
      where: { idempotencyKey: key },
      select: {
        id: true, guildId: true, nitradoConnId: true, userDiscordId: true,
        walletDelta: true, bankDelta: true, type: true, sourceRef: true,
      },
    });
    if (existing) {
      const legacyExpected = expectedDeltas(decision.calculated, policy.rewardTarget);
      assertMatchingLegacyLedger(existing, {
        guildId: scope.guildId,
        nitradoConnId: scope.nitradoConnId,
        userDiscordId: decision.userDiscordId,
        walletDelta: legacyExpected.walletDelta,
        bankDelta: legacyExpected.bankDelta,
        sourceRef: decision.id,
      });
      await tx.rewardDecision.update({
        where: { id: decision.id },
        data: { status: 'PAID', paid: decision.calculated, ledgerEntryId: existing.id },
      });
      return decision.calculated;
    }

    const limits = await rewardLimits(tx, scope, decision, normalized.timezone);
    if (normalized.cooldownSeconds > 0 && limits.lastPaidAt) {
      const elapsedSeconds = Math.floor((decision.createdAt.getTime() - limits.lastPaidAt.getTime()) / 1000);
      if (elapsedSeconds < normalized.cooldownSeconds) {
        await markSkipped(tx, decision.id, 'SKIPPED_COOLDOWN');
        return 0n;
      }
    }

    let amount = decision.calculated;
    if (normalized.dailyCap !== null) {
      const remaining = normalized.dailyCap - limits.paidToday;
      if (remaining <= 0n) {
        await markSkipped(tx, decision.id, 'SKIPPED_DAILY_CAP');
        return 0n;
      }
      if (amount > remaining) amount = remaining;
    }
    if (amount <= 0n) {
      await markSkipped(tx, decision.id, 'SKIPPED_DAILY_CAP');
      return 0n;
    }

    const { walletDelta, bankDelta } = expectedDeltas(amount, policy.rewardTarget);
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

    await tx.rewardDecision.update({
      where: { id: decision.id },
      data: {
        status: 'PAID',
        paid: amount,
        ledgerEntryId: booked.entryId,
        reasonCode: amount < decision.calculated ? 'PAID_DAILY_CAP_PARTIAL' : 'PAID',
      },
    });
    return amount;
  });
}

export async function bookPendingRewards(
  client: RewardBookingClient,
  scope: RewardBookingScope,
  opts: RewardBookingPolicy,
): Promise<{ paid: number; totalAmount: bigint; skipped: number }> {
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
  let skipped = 0;
  let totalAmount = 0n;
  for (const decision of pending) {
    const amount = await finalizePendingReward(client, scope, decision, opts);
    if (amount === null) continue;
    if (amount > 0n) {
      paid++;
      totalAmount += amount;
    } else {
      skipped++;
    }
  }
  return { paid, totalAmount, skipped };
}
