import { Collection, REST, Routes } from 'discord.js';
import { Command, ExtendedClient } from '../types';
import { logger } from '../utils/logger';
import path from 'path';
import fs from 'fs';

/**
 * Command-Handler: Lädt und registriert alle Slash-Commands.
 * Sektion 5: Übersichtliche, erweiterbare Command-Struktur.
 */
export async function loadCommands(client: ExtendedClient): Promise<void> {
  client.commands = new Collection<string, Command>();

  const commandDirs = [
    path.join(__dirname, 'user'),
    path.join(__dirname, 'admin'),
    path.join(__dirname, 'developer'),
  ];

  for (const dir of commandDirs) {
    if (!fs.existsSync(dir)) continue;

    const files = fs.readdirSync(dir).filter(f => f.endsWith('.ts') || f.endsWith('.js'));

    for (const file of files) {
      try {
        // WICHTIG: require() statt dynamic import().
        // Mit tsconfig "module": "Node16" triggert dynamic import() den nativen
        // ESM-Resolver, der KEINE Directory-Imports (z.B. `from '../../types'`)
        // unterstuetzt \u2013 alle Command-Files wuerden mit ERR_UNSUPPORTED_DIR_IMPORT
        // crashen. require() laeuft ueber den CommonJS-Resolver von ts-node und
        // findet `index.ts` in Verzeichnissen problemlos.
        const commandModule = require(path.join(dir, file));

        // Bei CJS-kompilierten Modulen kann `default` doppelt verschachtelt sein
        // (Node 20 dynamic import aus CommonJS): m.default.default
        const maybeDefault = commandModule.default?.default ?? commandModule.default;

        // Default export
        if (maybeDefault?.data?.name && typeof maybeDefault.execute === 'function') {
          const command: Command = maybeDefault;
          client.commands.set(command.data.name, command);
          logger.info(`Command geladen: /${command.data.name}`);
        } else {
          // Named exports (z.B. moderation.ts mit kickCommand, banCommand, etc.)
          const source = commandModule.default && typeof commandModule.default === 'object'
            ? { ...commandModule, ...commandModule.default }
            : commandModule;
          for (const key of Object.keys(source)) {
            if (key === 'default' || key === '__esModule') continue;
            const exported = source[key];
            if (exported?.data?.name && typeof exported.execute === 'function') {
              client.commands.set(exported.data.name, exported as Command);
              logger.info(`Command geladen: /${exported.data.name}`);
            }
          }
        }
      } catch (error) {
        logger.error(`Fehler beim Laden von Command ${file}:`, error);
      }
    }
  }

  logger.info(`${client.commands.size} Commands geladen.`);
}

/**
 * Registriert alle Commands bei Discord.
 *
 * Wichtig: Wir leeren IMMER beide Scopes (global + Guild) bevor wir den
 * gewuenschten Scope neu befuellen. Sonst koennen Commands gleichzeitig
 * global UND per-Guild registriert sein \u2013 Discord merged das im
 * Autocomplete und zeigt jeden Subcommand doppelt an.
 */
export async function deployCommands(client: ExtendedClient, token: string, clientId: string, guildId?: string): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(token);

  const commandData = client.commands.map(c => c.data.toJSON());

  // 1) Globalen Scope leeren (verhindert Duplikate beim Guild-Deploy).
  try {
    const globalExisting = (await rest.get(Routes.applicationCommands(clientId))) as unknown[];
    if (Array.isArray(globalExisting) && globalExisting.length > 0) {
      await rest.put(Routes.applicationCommands(clientId), { body: [] });
      logger.info(`${globalExisting.length} globale Commands entfernt.`);
    }
  } catch (e) {
    logger.warn('Konnte globale Commands nicht pr\u00fcfen/loeschen:', e as Error);
  }

  // 2) Guild-Scope leeren \u2013 falls eine guildId konfiguriert ist UND
  //    wir global deployen wollen (sonst Duplikate). Beim Guild-Deploy
  //    ist das Leeren ueberfluessig, weil rest.put dort gleich ueberschreibt.
  if (!guildId) {
    // Beim globalen Deploy haben wir keine guildId, koennen also keinen
    // konkreten Guild-Scope leeren. Das ist OK \u2013 Admins, die vorher per
    // Guild deployt hatten, muessen einmalig manuell mit guildId deployen
    // und dann zurueck wechseln, ODER der Bot war ohnehin nur global.
  }

  try {
    if (guildId) {
      await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
        body: commandData,
      });
      logger.info(`${commandData.length} Commands auf Guild ${guildId} registriert.`);
    } else {
      await rest.put(Routes.applicationCommands(clientId), {
        body: commandData,
      });
      logger.info(`${commandData.length} globale Commands registriert.`);
    }
  } catch (error) {
    logger.error('Fehler beim Registrieren der Commands:', error);
    throw error;
  }
}
