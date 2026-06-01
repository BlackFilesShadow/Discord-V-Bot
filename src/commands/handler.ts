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

  // Collision-Guard: Merkt sich, aus welcher Datei ein Command-Name geladen
  // wurde. Wird derselbe Name aus einer zweiten Datei geladen, loggen wir eine
  // klare Warnung mit beiden Dateipfaden (statt still zu ueberschreiben).
  const commandSources = new Map<string, string>();
  let collisionCount = 0;
  const registerCommand = (cmd: Command, sourceFile: string): void => {
    const existing = commandSources.get(cmd.data.name);
    if (existing && existing !== sourceFile) {
      collisionCount++;
      logger.warn(
        `[Command-Collision] /${cmd.data.name} ist doppelt definiert: ` +
        `"${existing}" und "${sourceFile}". Letztere ueberschreibt erstere. ` +
        `Bitte doppelten Command-Namen aufloesen.`,
      );
      if (process.env.COMMAND_LOADER_STRICT === 'true') {
        throw new Error(`Command-Collision: /${cmd.data.name} in "${existing}" und "${sourceFile}"`);
      }
    }
    commandSources.set(cmd.data.name, sourceFile);
    client.commands.set(cmd.data.name, cmd);
  };

  const commandDirs = [
    path.join(__dirname, 'user'),
    path.join(__dirname, 'admin'),
    path.join(__dirname, 'developer'),
    path.join(__dirname, 'dashboard'),
  ];

  for (const dir of commandDirs) {
    if (!fs.existsSync(dir)) continue;

    const files = fs.readdirSync(dir).filter(f => f.endsWith('.ts') || f.endsWith('.js'));

    for (const file of files) {
      const relSource = path.join(path.basename(dir), file);
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
          registerCommand(command, relSource);
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
              registerCommand(exported as Command, relSource);
              logger.info(`Command geladen: /${exported.data.name}`);
            }
          }
        }
      } catch (error) {
        logger.error(`Fehler beim Laden von Command ${file}:`, error);
      }
    }
  }

  if (collisionCount > 0) {
    logger.warn(`[Command-Collision] ${collisionCount} doppelte Command-Name(n) erkannt.`);
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

  // GUILD-DEPLOY: nur Guild-Scope schreiben - instant verfuegbar.
  // GLOBAL-DEPLOY: nur globalen Scope schreiben (kann bis 1h propagieren).
  // Niemals den jeweils anderen Scope loeschen, sonst entstehen Luecken.
  try {
    if (guildId) {
      await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commandData });
      logger.info(`${commandData.length} Commands auf Guild ${guildId} registriert (instant).`);
    } else {
      await rest.put(Routes.applicationCommands(clientId), { body: commandData });
      logger.info(`${commandData.length} globale Commands registriert.`);
    }
  } catch (error) {
    logger.error('Fehler beim Registrieren der Commands:', error);
    throw error;
  }
}
