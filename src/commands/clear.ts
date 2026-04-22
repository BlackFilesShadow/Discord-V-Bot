import { Client, GatewayIntentBits, REST, Routes } from 'discord.js';
import { config } from '../config';
import { logger } from '../utils/logger';

/**
 * Clear-Commands-Script: L\u00f6scht ALLE registrierten Slash-Commands.
 *
 * Wichtig: Wir leeren NICHT nur den globalen Scope und den per .env
 * konfigurierten Guild, sondern ALLE Guilds, in denen der Bot Mitglied ist.
 * Andernfalls bleiben alte Guild-Registrierungen aus frueheren Deploys
 * uebrig und Discord zeigt jeden Subcommand doppelt an (global + Guild).
 *
 * Aufruf: `npm run clear-commands`
 */
async function clearAll(): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(config.discord.token);
  const clientId = config.discord.clientId;

  // 1) Globale Commands loeschen
  try {
    const globals = (await rest.get(Routes.applicationCommands(clientId))) as unknown[];
    await rest.put(Routes.applicationCommands(clientId), { body: [] });
    logger.info(`${Array.isArray(globals) ? globals.length : 0} globale Commands geloescht.`);
  } catch (err) {
    logger.error('Konnte globale Commands nicht loeschen:', err as Error);
  }

  // 2) Guild-Commands loeschen \u2013 fuer ALLE Guilds, in denen der Bot ist.
  //    Wir holen die Guild-Liste \u00fcber den Gateway, weil die REST-API allein
  //    keine "list my guilds"-Route hat.
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  let cleared = 0;
  try {
    await client.login(config.discord.token);
    await new Promise<void>(resolve => client.once('ready', () => resolve()));

    const guilds = [...client.guilds.cache.values()];
    logger.info(`Bot ist in ${guilds.length} Guild(s). Leere Command-Scope in jeder...`);

    for (const guild of guilds) {
      try {
        const existing = (await rest.get(
          Routes.applicationGuildCommands(clientId, guild.id),
        )) as unknown[];
        if (Array.isArray(existing) && existing.length > 0) {
          await rest.put(Routes.applicationGuildCommands(clientId, guild.id), { body: [] });
          logger.info(`Guild ${guild.name} (${guild.id}): ${existing.length} Commands geloescht.`);
          cleared += existing.length;
        } else {
          logger.info(`Guild ${guild.name} (${guild.id}): bereits leer.`);
        }
      } catch (err) {
        logger.error(`Guild ${guild.name} (${guild.id}): Fehler beim Loeschen \u2013 ${(err as Error).message}`);
      }
    }
  } catch (err) {
    logger.error('Konnte Bot-Login f\u00fcr Guild-Discovery nicht ausfuehren:', err as Error);
  } finally {
    try { await client.destroy(); } catch { /* ignore */ }
  }

  logger.info(`Fertig. Insgesamt ${cleared} Guild-Commands geloescht. Jetzt \`npm run deploy-commands\` ausfuehren.`);
  process.exit(0);
}

clearAll().catch(err => {
  logger.error('Clear-Fehler:', err);
  process.exit(1);
});
