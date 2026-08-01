/**
 * RewardEngine (Phase 3, Schritt 4) — Shadow/WOULD_PAY-Modus.
 *
 * Leitet aus normalisierten AdmEvents idempotente RewardDecisions ab, OHNE Geld
 * zu buchen. Die Idempotenz kommt aus dem Unique-Key (admEventId + rewardRuleId):
 * dieselbe Kill-Zeile kann NIE zweimal eine Auszahlung erzeugen (Release-Blocker
 * gegen Mehrfach-Auszahlung).
 *
 * Status im Shadow:
 *   PENDING  -> "wuerde zahlen" (calculated gesetzt, paid=0, noch kein Ledger)
 *   SKIPPED  -> kein Reward (reasonCode erklaert warum)
 * Die Umstellung PENDING->PAID (echte Ledgerbuchung) erfolgt erst in Phase 5.
 */

export interface ShadowRewardRule {
  rewardRuleId: string; // z.B. 'pvp:default'
  baseAmount: bigint;   // Flat pro zulaessigem Kill (Shadow-Platzhalter, echte Regeln = Phase 5)
}

export interface PvpAdmEvent {
  id: string;
  actorGameId: string | null;  // Opfer
  targetGameId: string | null; // Killer
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

/**
 * Reine Entscheidung fuer EIN PvP-Kill-Event. Belohnt wird der Killer
 * (targetGameId). Kein verifizierter Link -> SKIPPED (aber Killfeed-Anzeige
 * bleibt davon unberuehrt, KILL-ECO-001).
 */
export function decidePvpReward(
  event: PvpAdmEvent,
  killerUserDiscordId: string | null,
  rule: ShadowRewardRule,
): RewardDecisionInput {
  const base = {
    admEventId: event.id,
    rewardRuleId: rule.rewardRuleId,
  };
  if (!event.targetGameId) {
    return { ...base, userDiscordId: null, status: 'SKIPPED', calculated: 0n, reasonCode: 'SKIPPED_INVALID_IDENTITY' };
  }
  if (event.actorGameId && event.actorGameId === event.targetGameId) {
    return { ...base, userDiscordId: null, status: 'SKIPPED', calculated: 0n, reasonCode: 'SKIPPED_ANTI_FARM' };
  }
  if (!killerUserDiscordId) {
    return { ...base, userDiscordId: null, status: 'SKIPPED', calculated: rule.baseAmount, reasonCode: 'SKIPPED_UNLINKED_KILLER' };
  }
  return { ...base, userDiscordId: killerUserDiscordId, status: 'PENDING', calculated: rule.baseAmount, reasonCode: 'WOULD_PAY_SHADOW' };
}

export interface RewardEngineScope {
  guildId: string;
  nitradoConnId: string;
}

/** Prisma-Teilschnittstelle (fuer Testbarkeit ohne echten Client). */
export interface RewardEngineClient {
  admEvent: {
    findMany: (args: unknown) => Promise<Array<{ id: string; actorGameId: string | null; targetGameId: string | null }>>;
  };
  economyLink: {
    findUnique: (args: unknown) => Promise<{ userDiscordId: string } | null>;
  };
  rewardDecision: {
    create: (args: { data: Record<string, unknown> }) => Promise<unknown>;
  };
}

function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002';
}

/**
 * Verarbeitet PvP-Kill-Events im Shadow-Modus zu RewardDecisions. Idempotent:
 * bereits entschiedene Events (Unique admEventId+rewardRuleId) werden
 * uebersprungen. Bucht KEIN Geld.
 */
export async function runPvpRewardShadow(
  client: RewardEngineClient,
  scope: RewardEngineScope,
  rule: ShadowRewardRule,
  limit = 500,
): Promise<{ decided: number; wouldPay: number; skipped: number }> {
  const events = await client.admEvent.findMany({
    where: { guildId: scope.guildId, nitradoConnId: scope.nitradoConnId, eventType: 'PLAYER_KILLED' },
    orderBy: { occurredAt: 'asc' },
    take: limit,
  });

  let decided = 0, wouldPay = 0, skipped = 0;
  for (const ev of events) {
    let userDiscordId: string | null = null;
    if (ev.targetGameId) {
      const link = await client.economyLink.findUnique({
        where: { guildId_nitradoConnId_gameId: { guildId: scope.guildId, nitradoConnId: scope.nitradoConnId, gameId: ev.targetGameId } },
      });
      userDiscordId = link?.userDiscordId ?? null;
    }
    const decision = decidePvpReward(ev, userDiscordId, rule);
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
      if (!isUniqueViolation(e)) throw e; // bereits entschieden -> idempotent ueberspringen
    }
  }
  return { decided, wouldPay, skipped };
}
