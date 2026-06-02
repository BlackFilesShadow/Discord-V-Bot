import { Events, ActivityType } from 'discord.js';
import { BotEvent, ExtendedClient } from '../types';
import { logger } from '../utils/logger';
import { guildGauge, wsLatencyGauge } from '../utils/metrics';
import { restoreAllFeeds } from '../modules/leaderboard/leaderboardFeed';
import { startAuditLogRetentionScheduler } from '../modules/logging/auditRetentionScheduler';
import { scheduleProviderCooldownSync } from '../modules/ai/providerStats';
import { startMemberSyncScheduler } from '../modules/members/memberSyncScheduler';

/**
 * Ready-Event: Bot ist verbunden und bereit.
 */
const readyEvent: BotEvent = {
  name: Events.ClientReady,
  once: true,
  execute: async (client: unknown) => {
    const c = client as ExtendedClient;
    logger.info(`Bot eingeloggt als ${c.user?.tag}`);
    logger.info(`Verbunden mit ${c.guilds.cache.size} Server(n)`);
    logger.info(`${c.commands.size} Commands geladen`);

    // Status setzen
    c.user?.setActivity('Discord-V-Bot | /help', {
      type: ActivityType.Watching,
    });

    // Telemetrie-Gauges initialisieren + periodisch aktualisieren
    const updateGauges = () => {
      guildGauge.set(c.guilds.cache.size);
      const ping = c.ws.ping;
      if (Number.isFinite(ping) && ping >= 0) wsLatencyGauge.set(ping);
    };
    updateGauges();
    setInterval(updateGauges, 30_000).unref?.();

    // Persistente Leaderboard-Feeds wiederherstellen (best-effort).
    try {
      await restoreAllFeeds(c);
    } catch (e) {
      logger.warn('Leaderboard-Feed-Restore fehlgeschlagen', e as Error);
    }

    // P0-Hardening: Audit-Log-Retention (Daily-Job, Default 90 Tage).
    startAuditLogRetentionScheduler();

    // P0-Hardening: Provider-Cooldown-Sync (DB <-> in-memory, alle 60s).
    // Sorgt dafuer dass Replicas den 429-Cooldown teilen + Restart-sicher.
    scheduleProviderCooldownSync();

    // Spec §11: Periodischer Member-Sync (default AUS, opt-in via MEMBER_SYNC_ENABLED).
    startMemberSyncScheduler(c);
  },
};

export default readyEvent;
