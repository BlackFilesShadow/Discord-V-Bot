import { Events, ActivityType } from 'discord.js';
import { BotEvent, ExtendedClient } from '../types';
import { logger } from '../utils/logger';
import { guildGauge, wsLatencyGauge } from '../utils/metrics';

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
  },
};

export default readyEvent;
