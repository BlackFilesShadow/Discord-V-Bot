/**
 * RewardEngine — idempotente ADM-Reward-Entscheidungen.
 *
 * Event-Rewards duerfen nur entstehen, wenn die DayZ-Identitaet zum Zeitpunkt
 * des Ereignisses bereits mit Discord verknuepft war. Der Aufloeser erhaelt
 * deshalb occurredAt mit; historische Events vor dem aktuellen Link-Cutoff
 * werden dauerhaft SKIPPED statt spaeter nachbezahlt. Ebenso werden Events
 * bei deaktivierter/0-Coin-Regel dauerhaft konsumiert und nie spaeter backpaid.
 */

export interface ShadowRewardRule {
  rewardRuleId: string;
  baseAmount: bigint;
}

export interface PvpAdmEvent {
  id: string;
  actorGameId: string | null;
  targetGameId: string | null;
  occurredAt: Date | null;
}

export type RewardStatus = 'PENDING' | 'SKIPPED';

export interface RewardDecisionInput {
  admEventId: string;
  rewardRuleId: string;
  userDiscordId: string | null;
  status: RewardStatus;
  calculated: bigint;
  reasonCode: string;
}

export function decidePvpReward(
  event: PvpAdmEvent,
  killerUserDiscordId: string | null,
  rule: ShadowRewardRule,
): RewardDecisionInput {
  const base = { admEventId: event.id, rewardRuleId: rule.rewardRuleId };
  if (!event.targetGameId) {
    return { ...base, userDiscordId: null, status: 'SKIPPED', calculated: 0n, reasonCode: 'SKIPPED_INVALID_IDENTITY' };
  }
  if (event.actorGameId && event.actorGameId === event.targetGameId) {
    return { ...base, userDiscordId: null, status: 'SKIPPED', calculated: 0n, reasonCode: 'SKIPPED_ANTI_FARM' };
  }
  if (rule.baseAmount <= 0n) {
    return { ...base, userDiscordId: null, status: 'SKIPPED', calculated: 0n, reasonCode: 'SKIPPED_REWARD_DISABLED' };
  }
  if (!killerUserDiscordId) {
    return { ...base, userDiscordId: null, status: 'SKIPPED', calculated: rule.baseAmount, reasonCode: 'SKIPPED_UNLINKED_OR_PRELINK_KILLER' };
  }
  return { ...base, userDiscordId: killerUserDiscordId, status: 'PENDING', calculated: rule.baseAmount, reasonCode: 'WOULD_PAY_SHADOW' };
}

export interface RewardEngineScope {
  guildId: string;
  nitradoConnId: string;
}

export interface RewardEngineClient {
  admEvent: {
    findMany: (args: unknown) => Promise<PvpAdmEvent[]>;
  };
  rewardDecision: {
    create: (args: { data: Record<string, unknown> }) => Promise<unknown>;
  };
}

/** GUID + Ereigniszeit -> Discord nur wenn der Link zu diesem Zeitpunkt aktiv war. */
export type ResolveUserAtFn = (gameId: string, occurredAt: Date | null) => Promise<string | null>;

function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002';
}

export async function runPvpRewardShadow(
  client: RewardEngineClient,
  scope: RewardEngineScope,
  rule: ShadowRewardRule,
  resolveUserAt: ResolveUserAtFn,
  limit = 500,
): Promise<{ decided: number; wouldPay: number; skipped: number }> {
  const events = await client.admEvent.findMany({
    where: { guildId: scope.guildId, nitradoConnId: scope.nitradoConnId, eventType: 'PLAYER_KILLED' },
    orderBy: { occurredAt: 'asc' },
    take: limit,
  });

  let decided = 0, wouldPay = 0, skipped = 0;
  for (const event of events) {
    // Bei deaktivierter/0-Coin-Regel ist keine Identitaetsaufloesung noetig.
    // Die Entscheidung wird trotzdem persistent SKIPPED, damit ein spaeteres
    // Aktivieren der Regel keine historischen Kills nachbezahlt.
    const userDiscordId = rule.baseAmount > 0n && event.targetGameId
      ? await resolveUserAt(event.targetGameId, event.occurredAt)
      : null;
    const decision = decidePvpReward(event, userDiscordId, rule);
    try {
      await client.rewardDecision.create({
        data: {
          admEventId: decision.admEventId,
          rewardRuleId: decision.rewardRuleId,
          guildId: scope.guildId,
          nitradoConnId: scope.nitradoConnId,
          userDiscordId: decision.userDiscordId,
          status: decision.status,
          calculated: decision.calculated,
          paid: 0n,
          reasonCode: decision.reasonCode,
        },
      });
      decided++;
      if (decision.status === 'PENDING') wouldPay++; else skipped++;
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
    }
  }
  return { decided, wouldPay, skipped };
}
