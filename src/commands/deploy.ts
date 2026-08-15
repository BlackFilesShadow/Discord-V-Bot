import { Client, Collection, GatewayIntentBits } from 'discord.js';
import { ExtendedClient } from '../types';
import { config } from '../config';
import { loadCommands, deployCommandsScoped } from './handler';
import { logger } from '../utils/logger';

/**
 * Deploy-Script: Registriert die aktuell geladenen Discord-Slash-Commands
 * scope-getrennt.
 *
 * Globale Bot-Admin-/DEV-Verwaltungsfunktionen sind in das Web-Dashboard
 * migriert und werden hier nicht mehr als Slash-Commands erzeugt. Globale
 * Herstellerfunktionen bleiben erhalten; alle weiteren Commands werden
 * guild-scoped registriert.
 */
async function deploy(): Promise<void> {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] }) as ExtendedClient;
  client.commands = new Collection();

  await loadCommands(client);

  client.once('clientReady', async () => {
    try {
      const guildIds = [...client.guilds.cache.keys()];
      const result = await deployCommandsScoped(client, config.discord.token, config.discord.clientId, guildIds);
      logger.info(
        `Commands deployed: ${result.globalCount} global, ${result.guildCount} guild-scoped auf ` +
        `${result.guildsOk}/${guildIds.length} Guild(s).`,
      );
      if (result.guildsFailed > 0) {
        throw new Error(
          `Command-Deploy unvollständig: ${result.guildsFailed}/${guildIds.length} Guild(s) fehlgeschlagen ` +
          `(${result.failedGuildIds.join(', ')}).`,
        );
      }
    } catch (err) {
      logger.error('Deploy-Fehler:', err);
      process.exit(1);
      return;
    }
    process.exit(0);
  });

  await client.login(config.discord.token);
}

deploy().catch(err => {
  logger.error('Deploy-Fehler:', err);
  process.exit(1);
});
