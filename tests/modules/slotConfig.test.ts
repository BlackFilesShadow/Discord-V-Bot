/**
 * Phase 5: EconomySlotConfig-Gate. Produktive ADM-Rewards nur bei aktivem Slot
 * UND admRewardsEnabled; sonst shadow-sicher deaktiviert.
 */
import {
  getSlotEconomyConfig, admRewardsActive, type SlotConfigClient, type SlotEconomyConfigRow,
} from '../../src/modules/economy/slotConfig';

const CFG: SlotEconomyConfigRow = {
  enabled: true, admRewardsEnabled: true, rewardTarget: 'WALLET', timezone: 'Europe/Berlin',
};

describe('admRewardsActive', () => {
  it('false ohne Konfiguration', () => {
    expect(admRewardsActive(null)).toBe(false);
  });
  it('false wenn Slot deaktiviert', () => {
    expect(admRewardsActive({ ...CFG, enabled: false })).toBe(false);
  });
  it('false wenn admRewardsEnabled aus', () => {
    expect(admRewardsActive({ ...CFG, admRewardsEnabled: false })).toBe(false);
  });
  it('true wenn beide aktiv', () => {
    expect(admRewardsActive(CFG)).toBe(true);
  });
});

describe('getSlotEconomyConfig', () => {
  function makeClient(row: SlotEconomyConfigRow | null): SlotConfigClient {
    return {
      economySlotConfig: { findUnique: async () => row },
    };
  }

  it('liefert Konfiguration bei Treffer', async () => {
    const cfg = await getSlotEconomyConfig(makeClient(CFG), { guildId: 'g', nitradoConnId: 'n' });
    expect(cfg?.admRewardsEnabled).toBe(true);
    expect(admRewardsActive(cfg)).toBe(true);
  });

  it('liefert null ohne Treffer -> inaktiv', async () => {
    const cfg = await getSlotEconomyConfig(makeClient(null), { guildId: 'g', nitradoConnId: 'n' });
    expect(cfg).toBeNull();
    expect(admRewardsActive(cfg)).toBe(false);
  });
});
