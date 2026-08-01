/**
 * EconomyRewardRules (Phase 5) — Laden konfigurierbarer Reward-Regeln.
 *
 * Fehlt eine Regel oder ist sie deaktiviert, ist der effektive Basisbetrag 0.
 * Damit bleibt die Reward-Pipeline shadow-sicher: es fliesst erst dann Geld,
 * wenn eine Regel bewusst mit `enabled=true` und `baseAmount>0` angelegt wird.
 */

export interface RewardRuleRow {
  ruleKey: string;
  enabled: boolean;
  baseAmount: bigint;
  rewardTarget: 'WALLET' | 'BANK';
  dailyCap: bigint | null;
  cooldownSeconds: number;
}

export interface RewardRuleScope {
  guildId: string;
  nitradoConnId: string;
}

export interface RewardRuleClient {
  economyRewardRule: {
    findUnique: (args: unknown) => Promise<{
      ruleKey: string;
      enabled: boolean;
      baseAmount: bigint;
      rewardTarget: 'WALLET' | 'BANK';
      dailyCap: bigint | null;
      cooldownSeconds: number;
    } | null>;
  };
}

/** Effektiver Basisbetrag: 0, wenn Regel fehlt oder deaktiviert. */
export function effectiveBaseAmount(rule: RewardRuleRow | null): bigint {
  return rule?.enabled ? rule.baseAmount : 0n;
}

export async function getRewardRule(
  client: RewardRuleClient,
  scope: RewardRuleScope,
  ruleKey: string,
): Promise<RewardRuleRow | null> {
  const row = await client.economyRewardRule.findUnique({
    where: {
      guildId_nitradoConnId_ruleKey: {
        guildId: scope.guildId,
        nitradoConnId: scope.nitradoConnId,
        ruleKey,
      },
    },
  });
  if (!row) return null;
  return {
    ruleKey: row.ruleKey,
    enabled: row.enabled,
    baseAmount: row.baseAmount,
    rewardTarget: row.rewardTarget,
    dailyCap: row.dailyCap,
    cooldownSeconds: row.cooldownSeconds,
  };
}
