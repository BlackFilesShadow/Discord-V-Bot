import { Client, Collection, GatewayIntentBits, Partials } from 'discord.js';
import { ExtendedClient } from '../types';
import { config } from '../config';
import { loadCommands, deployCommands } from './handler';
import { logger } from '../utils/logger';

/**
 * Deploy-Script: Registriert alle Slash-Commands bei Discord.
 */
async function deploy(): Promise<void> {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
  }) as ExtendedClient;

  client.commands = new Collection();

  await loadCommands(client);
  await deployCommands(client, config.discord.token, config.discord.clientId, config.discord.guildId);

  logger.info('Commands erfolgreich deployed.');
  process.exit(0);
}

deploy().catch(err => {
  logger.error('Deploy-Fehler:', err);
  process.exit(1);
});
