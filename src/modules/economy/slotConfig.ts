/**
 * EconomySlotConfig (Phase 5) — Wirtschafts-Master-Konfiguration pro Slot.
 *
 * `admRewardsActive` ist das Gate fuer produktive ADM-Rewards: nur wenn der Slot
 * aktiv UND `admRewardsEnabled` ist, darf spaeter echtes Geld gebucht werden.
 * Fehlt die Konfiguration, gilt alles als deaktiviert (shadow-sicher).
 */

export interface SlotEconomyConfigRow {
  enabled: boolean;
  admRewardsEnabled: boolean;
  rewardTarget: 'WALLET' | 'BANK';
  timezone: string;
}

export interface SlotConfigScope {
  guildId: string;
  nitradoConnId: string;
}

export interface SlotConfigClient {
  economySlotConfig: {
    findUnique: (args: unknown) => Promise<{
      enabled: boolean;
      admRewardsEnabled: boolean;
      rewardTarget: 'WALLET' | 'BANK';
      timezone: string;
    } | null>;
  };
}

/** Produktive ADM-Rewards nur bei aktivem Slot UND admRewardsEnabled. */
export function admRewardsActive(cfg: SlotEconomyConfigRow | null): boolean {
  return !!(cfg?.enabled && cfg.admRewardsEnabled);
}

export async function getSlotEconomyConfig(
  client: SlotConfigClient,
  scope: SlotConfigScope,
): Promise<SlotEconomyConfigRow | null> {
  const row = await client.economySlotConfig.findUnique({
    where: { guildId_nitradoConnId: { guildId: scope.guildId, nitradoConnId: scope.nitradoConnId } },
  });
  if (!row) return null;
  return {
    enabled: row.enabled,
    admRewardsEnabled: row.admRewardsEnabled,
    rewardTarget: row.rewardTarget,
    timezone: row.timezone,
  };
}
