import { Events, ActivityType } from 'discord.js';
import { BotEvent, ExtendedClient } from '../types';
import { logger } from '../utils/logger';

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
  },
};

export default readyEvent;
