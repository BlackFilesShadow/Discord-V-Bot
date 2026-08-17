import prisma from '../../database/prisma';
import { config } from '../../config';
import { economySubjectKey } from '../economy/subjectKey';
import { runLeaveWhitelistCleanupStep } from './leaveCleanupWhitelist';

export type LeaveLinkEconomyState = 'DONE' | 'WAITING';

export interface LeaveLinkEconomyResult {
  state: LeaveLinkEconomyState;
  reason?: 'WHITELIST_PENDING' | 'ACTIVE_LOTTERY';
  subjectKey: string;
  rewardDecisionsSkipped: number;
  accountsDeleted: number;
  linksDeleted: number;
  rewardStatesDeleted: number;
  historyRowsPseudonymized: number;
}

interface RawClient {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

function rawClient(value: unknown): RawClient {
  return value as RawClient;
}

async function hasActiveLotteryObligation(raw: RawClient, guildId: string, userDiscordId: string): Promise<boolean> {
  const rows = await raw.$queryRawUnsafe<Array<{ exists: boolean }>>(
    `SELECT EXISTS (
      SELECT 1
      FROM "LotteryEntry" e
      JOIN "LotteryRound" r ON r."id" = e."roundId"
      WHERE e."guildId"=$1
        AND e."userDiscordId"=$2
        AND r."guildId"=$1
        AND r."status" IN ('ACTIVE'::"LotteryRoundStatus", 'DRAWING'::"LotteryRoundStatus", 'REFUNDING'::"LotteryRoundStatus")
      UNION ALL
      SELECT 1
      FROM "LotteryRound" r
      WHERE r."guildId"=$1
        AND r."winnerDiscordId"=$2
        AND r."status" IN ('ACTIVE'::"LotteryRoundStatus", 'DRAWING'::"LotteryRoundStatus", 'REFUNDING'::"LotteryRoundStatus")
    ) AS exists`,
    guildId,
    userDiscordId,
  );
  return rows[0]?.exists === true;
}

async function assertLedgerKeyMigrationSafe(
  raw: RawClient,
  guildId: string,
  userDiscordId: string,
  subjectKey: string,
): Promise<void> {
  const rows = await raw.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT old."id"
       FROM "EconomyLedgerEntry" old
       JOIN "EconomyLedgerEntry" existing
         ON existing."idempotencyKey" = replace(old."idempotencyKey", $2, $3)
        AND existing."id" <> old."id"
      WHERE old."guildId"=$1
        AND old."userDiscordId"=$2
        AND position($2 in old."idempotencyKey") > 0
        AND (old."idempotencyKey" LIKE 'startbalance:%' OR old."idempotencyKey" LIKE 'interest:%')
      LIMIT 1`,
    guildId,
    userDiscordId,
    subjectKey,
  );
  if (rows.length > 0) throw new Error('Leave-Economy: Idempotency-Key-Pseudonymisierung kollidiert mit bestehender Historie.');
}

async function pseudonymizeHistory(
  raw: RawClient,
  guildId: string,
  userDiscordId: string,
  subjectKey: string,
): Promise<{ rows: number; rewardDecisionsSkipped: number }> {
  await assertLedgerKeyMigrationSafe(raw, guildId, userDiscordId, subjectKey);

  let rows = 0;
  const rewardDecisionsSkipped = await raw.$executeRawUnsafe(
    `UPDATE "RewardDecision"
        SET "status"='SKIPPED'::"RewardDecisionStatus",
            "reasonCode"='LEAVE_RESET',
            "updatedAt"=CURRENT_TIMESTAMP
      WHERE "guildId"=$1
        AND "userDiscordId"=$2
        AND "status" IN ('PENDING'::"RewardDecisionStatus", 'REVIEW'::"RewardDecisionStatus", 'FAILED_RETRYABLE'::"RewardDecisionStatus")`,
    guildId,
    userDiscordId,
  );
  rows += rewardDecisionsSkipped;

  rows += await raw.$executeRawUnsafe(
    `UPDATE "RewardDecision" SET "userDiscordId"=$3, "updatedAt"=CURRENT_TIMESTAMP
      WHERE "guildId"=$1 AND "userDiscordId"=$2`,
    guildId, userDiscordId, subjectKey,
  );

  // Anti-Replay-Wasserstand bleibt erhalten. Weder rewardEpoch noch
  // bucketsCredited werden veraendert.
  rows += await raw.$executeRawUnsafe(
    `UPDATE "PlaytimeRewardProgress" SET "userDiscordId"=$3, "updatedAt"=CURRENT_TIMESTAMP
      WHERE "guildId"=$1 AND "userDiscordId"=$2`,
    guildId, userDiscordId, subjectKey,
  );

  rows += await raw.$executeRawUnsafe(
    `UPDATE "EconomyLedgerEntry"
        SET "idempotencyKey"=CASE
              WHEN position($2 in "idempotencyKey") > 0
               AND ("idempotencyKey" LIKE 'startbalance:%' OR "idempotencyKey" LIKE 'interest:%')
              THEN replace("idempotencyKey", $2, $3)
              ELSE "idempotencyKey"
            END,
            "userDiscordId"=$3,
            "sourceRef"=CASE WHEN "sourceRef" IS NULL THEN NULL ELSE replace("sourceRef", $2, $3) END
      WHERE "guildId"=$1 AND "userDiscordId"=$2`,
    guildId, userDiscordId, subjectKey,
  );

  rows += await raw.$executeRawUnsafe(
    `UPDATE "EconomyTransaction"
        SET "userDiscordId"=CASE WHEN "userDiscordId"=$2 THEN $3 ELSE "userDiscordId" END,
            "actorDiscordId"=CASE WHEN "actorDiscordId"=$2 THEN $3 ELSE "actorDiscordId" END,
            "counterpartDiscordId"=CASE WHEN "counterpartDiscordId"=$2 THEN $3 ELSE "counterpartDiscordId" END
      WHERE "guildId"=$1
        AND ("userDiscordId"=$2 OR "actorDiscordId"=$2 OR "counterpartDiscordId"=$2)`,
    guildId, userDiscordId, subjectKey,
  );

  rows += await raw.$executeRawUnsafe(
    `UPDATE "EconomyVirtualAccountEntry"
        SET "userDiscordId"=CASE WHEN "userDiscordId"=$2 THEN $3 ELSE "userDiscordId" END,
            "actorDiscordId"=CASE WHEN "actorDiscordId"=$2 THEN $3 ELSE "actorDiscordId" END,
            "sourceRef"=CASE WHEN "sourceRef" IS NULL THEN NULL ELSE replace("sourceRef", $2, $3) END
      WHERE "guildId"=$1
        AND ("userDiscordId"=$2 OR "actorDiscordId"=$2 OR position($2 in COALESCE("sourceRef", '')) > 0)`,
    guildId, userDiscordId, subjectKey,
  );

  rows += await raw.$executeRawUnsafe(
    `UPDATE "EconomyVirtualAccount"
        SET "createdByDiscordId"=CASE WHEN "createdByDiscordId"=$2 THEN $3 ELSE "createdByDiscordId" END,
            "archivedByDiscordId"=CASE WHEN "archivedByDiscordId"=$2 THEN $3 ELSE "archivedByDiscordId" END,
            "updatedAt"=CURRENT_TIMESTAMP
      WHERE "guildId"=$1 AND ("createdByDiscordId"=$2 OR "archivedByDiscordId"=$2)`,
    guildId, userDiscordId, subjectKey,
  );

  rows += await raw.$executeRawUnsafe(
    `UPDATE "LotteryEntry" SET "userDiscordId"=$3, "updatedAt"=CURRENT_TIMESTAMP
      WHERE "guildId"=$1 AND "userDiscordId"=$2`,
    guildId, userDiscordId, subjectKey,
  );
  rows += await raw.$executeRawUnsafe(
    `UPDATE "LotteryPurchase" SET "userDiscordId"=$3
      WHERE "guildId"=$1 AND "userDiscordId"=$2`,
    guildId, userDiscordId, subjectKey,
  );
  rows += await raw.$executeRawUnsafe(
    `UPDATE "LotteryRound"
        SET "winnerDiscordId"=CASE WHEN "winnerDiscordId"=$2 THEN $3 ELSE "winnerDiscordId" END,
            "createdByDiscordId"=CASE WHEN "createdByDiscordId"=$2 THEN $3 ELSE "createdByDiscordId" END,
            "updatedAt"=CURRENT_TIMESTAMP
      WHERE "guildId"=$1 AND ("winnerDiscordId"=$2 OR "createdByDiscordId"=$2)`,
    guildId, userDiscordId, subjectKey,
  );

  rows += await raw.$executeRawUnsafe(
    `UPDATE "EconomyMarketPurchase" SET "userDiscordId"=$3
      WHERE "guildId"=$1 AND "userDiscordId"=$2`,
    guildId, userDiscordId, subjectKey,
  );
  rows += await raw.$executeRawUnsafe(
    `UPDATE "EconomyMarketListing"
        SET "createdByDiscordId"=CASE WHEN "createdByDiscordId"=$2 THEN $3 ELSE "createdByDiscordId" END,
            "archivedByDiscordId"=CASE WHEN "archivedByDiscordId"=$2 THEN $3 ELSE "archivedByDiscordId" END,
            "updatedAt"=CURRENT_TIMESTAMP
      WHERE "guildId"=$1 AND ("createdByDiscordId"=$2 OR "archivedByDiscordId"=$2)`,
    guildId, userDiscordId, subjectKey,
  );

  rows += await raw.$executeRawUnsafe(
    `UPDATE "CasinoRound" SET "userDiscordId"=$3
      WHERE "guildId"=$1 AND "userDiscordId"=$2`,
    guildId, userDiscordId, subjectKey,
  );

  return { rows, rewardDecisionsSkipped };
}

/**
 * Leave-1C — interner, noch NICHT produktiv verdrahteter Saga-Schritt.
 *
 * Reihenfolge:
 * 1. Whitelist/Nitrado aus Leave-1B muss remote bestaetigt DONE sein.
 * 2. Offene Lottery-Verpflichtungen blockieren den Economy-Reset fail-closed.
 * 3. Offene Rewards werden SKIPPED und unveraenderliche Historie pseudonymisiert.
 * 4. Mutable Accounts, Reward-State und GameIdentityLink werden entfernt.
 *
 * PlayerSession und insbesondere bucketsCredited werden niemals zurueckgesetzt.
 */
export async function runLeaveLinkEconomyCleanupStep(
  guildId: string,
  userDiscordId: string,
): Promise<LeaveLinkEconomyResult> {
  const subjectKey = economySubjectKey(guildId, userDiscordId, config.security.encryptionKey);
  const whitelist = await runLeaveWhitelistCleanupStep(guildId, userDiscordId);
  if (whitelist.state !== 'DONE') {
    return {
      state: 'WAITING',
      reason: 'WHITELIST_PENDING',
      subjectKey,
      rewardDecisionsSkipped: 0,
      accountsDeleted: 0,
      linksDeleted: 0,
      rewardStatesDeleted: 0,
      historyRowsPseudonymized: 0,
    };
  }

  const raw = rawClient(prisma);
  if (await hasActiveLotteryObligation(raw, guildId, userDiscordId)) {
    return {
      state: 'WAITING',
      reason: 'ACTIVE_LOTTERY',
      subjectKey,
      rewardDecisionsSkipped: 0,
      accountsDeleted: 0,
      linksDeleted: 0,
      rewardStatesDeleted: 0,
      historyRowsPseudonymized: 0,
    };
  }

  return prisma.$transaction(async tx => {
    const trx = rawClient(tx);
    const history = await pseudonymizeHistory(trx, guildId, userDiscordId, subjectKey);

    const accountsDeleted = await trx.$executeRawUnsafe(
      `DELETE FROM "EconomyAccount" WHERE "guildId"=$1 AND "userDiscordId"=$2`,
      guildId,
      userDiscordId,
    );
    const rewardStatesDeleted = await trx.$executeRawUnsafe(
      `DELETE FROM "EconomyLinkRewardState" WHERE "guildId"=$1 AND "userDiscordId"=$2`,
      guildId,
      userDiscordId,
    );
    const linksDeleted = await trx.$executeRawUnsafe(
      `DELETE FROM "GameIdentityLink" WHERE "guildId"=$1 AND "userDiscordId"=$2`,
      guildId,
      userDiscordId,
    );

    return {
      state: 'DONE' as const,
      subjectKey,
      rewardDecisionsSkipped: history.rewardDecisionsSkipped,
      accountsDeleted,
      linksDeleted,
      rewardStatesDeleted,
      historyRowsPseudonymized: history.rows,
    };
  });
}
