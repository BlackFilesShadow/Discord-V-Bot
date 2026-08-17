import { Events, ActivityType } from 'discord.js';
import { BotEvent, ExtendedClient } from '../types';
import { logger } from '../utils/logger';
import { guildGauge, wsLatencyGauge } from '../utils/metrics';
import { restoreAllFeeds, stopAllLeaderboardFeeds } from '../modules/leaderboard/leaderboardFeed';
import {
  startAuditLogRetentionScheduler,
  stopAuditLogRetentionScheduler,
} from '../modules/logging/auditRetentionScheduler';
import { hydrateCooldownsFromDb } from '../modules/ai/providerStats';
import { startMemberSyncScheduler, stopMemberSyncScheduler } from '../modules/members/memberSyncScheduler';
import { BOT_PRODUCT_NAME } from '../content/botInfo';

let gaugeTimer: NodeJS.Timeout | null = null;
let providerCooldownTimer: NodeJS.Timeout | null = null;

function startProviderCooldownSync(): void {
  if (providerCooldownTimer) return;
  void hydrateCooldownsFromDb();
  providerCooldownTimer = setInterval(() => {
    void hydrateCooldownsFromDb();
  }, 60_000);
  providerCooldownTimer.unref?.();
}

/** Ready-Event: Bot ist verbunden und bereit. */
const readyEvent: BotEvent = {
  name: Events.ClientReady,
  once: true,
  execute: async (client: unknown) => {
    const c = client as ExtendedClient;
    logger.info(`${BOT_PRODUCT_NAME} eingeloggt als ${c.user?.tag}`);
    logger.info(`Verbunden mit ${c.guilds.cache.size} Server(n)`);
    logger.info(`${c.commands.size} Discord-Commands geladen`);

    c.user?.setActivity(`${BOT_PRODUCT_NAME} | /help`, {
      type: ActivityType.Watching,
    });

    const updateGauges = () => {
      guildGauge.set(c.guilds.cache.size);
      const ping = c.ws.ping;
      if (Number.isFinite(ping) && ping >= 0) wsLatencyGauge.set(ping);
    };
    updateGauges();
    if (!gaugeTimer) {
      gaugeTimer = setInterval(updateGauges, 30_000);
      gaugeTimer.unref?.();
    }

    try {
      await restoreAllFeeds(c);
    } catch (e) {
      logger.warn('Leaderboard-Feed-Restore fehlgeschlagen', e as Error);
    }

    startAuditLogRetentionScheduler();
    startProviderCooldownSync();
    startMemberSyncScheduler(c);
  },
};

/**
 * Symmetrischer Shutdown fuer alle Dienste, die direkt aus ClientReady
 * gestartet werden. Persistierte Konfiguration bleibt unangetastet.
 */
export function stopReadyRuntime(): void {
  if (gaugeTimer) {
    clearInterval(gaugeTimer);
    gaugeTimer = null;
  }
  if (providerCooldownTimer) {
    clearInterval(providerCooldownTimer);
    providerCooldownTimer = null;
  }
  stopMemberSyncScheduler();
  stopAuditLogRetentionScheduler();
  stopAllLeaderboardFeeds();
}

export default readyEvent;
