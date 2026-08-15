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
 * Herstellerfunktionen (einschliesslich der bewusst erhaltenen
 * dev-manufacturer-Ausnahme) bleiben erhalten. Alle weiteren Commands werden
 * entsprechend ihrer Laufzeit-Klassifizierung guild-/global-gescoppt.
 */
async function deploy(): Promise<void> {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
  }) as ExtendedClient;

  client.commands = new Collection();

  await loadCommands(client);

  client.once('clientReady', async () => {
    try {
      const guildIds = [...client.guilds.cache.keys()];
      const res = await deployCommandsScoped(client, config.discord.token, config.discord.clientId, guildIds);
      logger.info(`Commands deployed: ${res.globalCount} global, ${res.guildCount} guild-scoped auf ${res.guildsOk} Guild(s).`);
    } catch (err) {
      logger.error('Deploy-Fehler:', err);
      process.exit(1);
    }
    process.exit(0);
  });

  await client.login(config.discord.token);
}

deploy().catch(err => {
  logger.error('Deploy-Fehler:', err);
  process.exit(1);
});
