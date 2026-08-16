/**
 * RewardEngine — idempotente ADM-Reward-Entscheidungen.
 *
 * Event-Rewards duerfen nur entstehen, wenn die DayZ-Identitaet zum Zeitpunkt
 * des Ereignisses bereits mit Discord verknuepft war. Historische Events vor
 * dem aktuellen Link-Cutoff werden dauerhaft SKIPPED statt spaeter nachbezahlt.
 *
 * Die Verarbeitung nutzt einen persistenten, monotonen High-Watermark. Damit
 * kann ein fester Batch-Limit niemals dazu fuehren, dass Events hinter den
 * ersten 500 Eintraegen dauerhaft verhungern. Ein Crash vor dem Cursor-Advance
 * ist sicher: RewardDecision ist weiterhin ueber Event+Rule idempotent.
 */

import {
  advanceRewardCursor,
  afterCursorWhere,
  getRewardCursor,
  type RewardCursorClient,
} from '../../economy/rewardCursor';

export interface ShadowRewardRule {
  rewardRuleId: string;
  baseAmount: bigint;
}

export interface PvpAdmEvent {
  id: string;
  actorGameId: string | null;
  targetGameId: string | null;
  occurredAt: Date | null;
  createdAt: Date;
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

interface ExistingDecisionRow {
  admEventId: string;
}

export interface RewardEngineClient extends RewardCursorClient {
  admEvent: {
    findMany: (args: unknown) => Promise<PvpAdmEvent[]>;
  };
  rewardDecision: {
    findMany: (args: unknown) => Promise<ExistingDecisionRow[]>;
    create: (args: { data: Record<string, unknown> }) => Promise<unknown>;
  };
}

/** GUID + Ereigniszeit -> Discord nur wenn der Link zu diesem Zeitpunkt aktiv war. */
export type ResolveUserAtFn = (gameId: string, occurredAt: Date | null) => Promise<string | null>;

function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002';
}

function streamName(ruleId: string): string {
  return `pvp:${ruleId}`.slice(0, 64);
}

export async function runPvpRewardShadow(
  client: RewardEngineClient,
  scope: RewardEngineScope,
  rule: ShadowRewardRule,
  resolveUserAt: ResolveUserAtFn,
  limit = 500,
  maxPages = 50,
): Promise<{ decided: number; wouldPay: number; skipped: number }> {
  const batchSize = Math.max(1, Math.min(2_000, Math.trunc(limit)));
  const pageLimit = Math.max(1, Math.min(500, Math.trunc(maxPages)));
  const stream = streamName(rule.rewardRuleId);
  let cursor = await getRewardCursor(client, scope, stream);

  let decided = 0;
  let wouldPay = 0;
  let skipped = 0;

  for (let page = 0; page < pageLimit; page++) {
    const events = await client.admEvent.findMany({
      where: {
        guildId: scope.guildId,
        nitradoConnId: scope.nitradoConnId,
        eventType: 'PLAYER_KILLED',
        ...afterCursorWhere(cursor, 'createdAt'),
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: batchSize,
    });
    if (events.length === 0) break;

    const existing = await client.rewardDecision.findMany({
      where: {
        rewardRuleId: rule.rewardRuleId,
        admEventId: { in: events.map(event => event.id) },
      },
      select: { admEventId: true },
    });
    const existingIds = new Set(existing.map(row => row.admEventId));

    for (const event of events) {
      if (existingIds.has(event.id)) continue;

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
        if (decision.status === 'PENDING') wouldPay++;
        else skipped++;
      } catch (e) {
        // Parallele Worker duerfen dieselbe Entscheidung sehen. Der Unique-Key
        // macht den Zweitversuch zu einem erfolgreichen idempotenten No-op.
        if (!isUniqueViolation(e)) throw e;
      }
    }

    // Erst NACH allen Entscheidungen der Seite avancieren. Ein Crash davor
    // wiederholt die Seite; bereits geschriebene Decisions verhindern Double-Pay.
    const last = events[events.length - 1];
    const next = { timestamp: last.createdAt, entityId: last.id };
    await advanceRewardCursor(client, scope, stream, next);
    cursor = next;

    if (events.length < batchSize) break;
  }

  return { decided, wouldPay, skipped };
}
