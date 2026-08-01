/**
 * Phase 5: EconomyRewardRule-Loader. Shadow-sicher — fehlt/deaktiviert -> 0.
 */
import {
  getRewardRule, effectiveBaseAmount, type RewardRuleClient, type RewardRuleRow,
} from '../../src/modules/economy/rewardRules';

const RULE: RewardRuleRow = {
  ruleKey: 'pvp:default', enabled: true, baseAmount: 500n,
  rewardTarget: 'WALLET', dailyCap: null, cooldownSeconds: 0,
};

describe('effectiveBaseAmount', () => {
  it('0 wenn Regel fehlt', () => {
    expect(effectiveBaseAmount(null)).toBe(0n);
  });
  it('0 wenn Regel deaktiviert', () => {
    expect(effectiveBaseAmount({ ...RULE, enabled: false })).toBe(0n);
  });
  it('baseAmount wenn aktiv', () => {
    expect(effectiveBaseAmount(RULE)).toBe(500n);
  });
});

describe('getRewardRule', () => {
  function makeClient(row: RewardRuleRow | null): RewardRuleClient {
    return {
      economyRewardRule: {
        findUnique: async (args: unknown) => {
          const key = (args as { where: { guildId_nitradoConnId_ruleKey: { ruleKey: string } } })
            .where.guildId_nitradoConnId_ruleKey.ruleKey;
          return row && row.ruleKey === key ? row : null;
        },
      },
    };
  }

  it('liefert Regel bei Treffer', async () => {
    const rule = await getRewardRule(makeClient(RULE), { guildId: 'g', nitradoConnId: 'n' }, 'pvp:default');
    expect(rule?.baseAmount).toBe(500n);
    expect(effectiveBaseAmount(rule)).toBe(500n);
  });

  it('liefert null ohne Treffer -> effektiv 0', async () => {
    const rule = await getRewardRule(makeClient(null), { guildId: 'g', nitradoConnId: 'n' }, 'pvp:default');
    expect(rule).toBeNull();
    expect(effectiveBaseAmount(rule)).toBe(0n);
  });
});
