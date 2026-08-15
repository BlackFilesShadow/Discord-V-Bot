import { Collection, REST, Routes } from 'discord.js';
import { Command, ExtendedClient } from '../types';
import { logger } from '../utils/logger';
import { classifyCommand } from './inventory';
import path from 'path';
import fs from 'fs';

class CommandCollisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandCollisionError';
  }
}

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
      const base = `[Command-Collision] /${cmd.data.name} ist doppelt definiert: ` +
        `"${existing}" und "${sourceFile}".`;
      // Strikt per Default: eine Namenskollision ist ein Konfigurationsfehler und
      // muss den gesamten Loader wirklich abbrechen. Ein normaler File-Import-
      // Fehler darf dagegen weiterhin isoliert geloggt werden, damit ein einzelnes
      // defektes optionales Command nicht pauschal alle anderen versteckt.
      if (process.env.COMMAND_LOADER_STRICT !== 'false') {
        logger.error(`${base} Abbruch (setze COMMAND_LOADER_STRICT=false zum Tolerieren).`);
        throw new CommandCollisionError(`Command-Collision: /${cmd.data.name} in "${existing}" und "${sourceFile}"`);
      }
      logger.warn(`${base} Letztere ueberschreibt erstere (COMMAND_LOADER_STRICT=false).`);
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
        // WICHTIG: require() statt dynamic import(). Mit tsconfig "module":
        // "Node16" wuerde der native ESM-Resolver Directory-Imports ablehnen.
        const commandModule = require(path.join(dir, file));
        const maybeDefault = commandModule.default?.default ?? commandModule.default;

        if (maybeDefault?.data?.name && typeof maybeDefault.execute === 'function') {
          const command: Command = maybeDefault;
          registerCommand(command, relSource);
          logger.info(`Command geladen: /${command.data.name}`);
        } else {
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
        // Kritische Invariante: Der Strict-Collision-Guard darf nicht vom
        // generischen Datei-Fehlerhandler wieder verschluckt werden.
        if (error instanceof CommandCollisionError) throw error;
        logger.error(`Fehler beim Laden von Command ${file}:`, error);
      }
    }
  }

  if (collisionCount > 0) {
    logger.warn(`[Command-Collision] ${collisionCount} doppelte Command-Name(n) erkannt.`);
  }
  client.commandSources = commandSources;
  client.commandCollisions = collisionCount;
  logger.info(`${client.commands.size} Commands geladen.`);
}

/** Registriert alle geladenen Commands in genau einem Discord-Scope. */
export async function deployCommands(client: ExtendedClient, token: string, clientId: string, guildId?: string): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(token);
  const commandData = client.commands.map(c => c.data.toJSON());
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

/**
 * Teilt die geladenen Commands anhand des kanonischen Inventars auf.
 * `staysInDiscord` ist die entscheidende Deploy-Grenze; migrierte Commands
 * koennen dadurch auch bei versehentlichem Wiederladen nicht zurueckkehren.
 */
export function splitCommandsByScope(client: ExtendedClient): {
  global: ReturnType<Command['data']['toJSON']>[];
  guild: ReturnType<Command['data']['toJSON']>[];
} {
  const globalCmds: ReturnType<Command['data']['toJSON']>[] = [];
  const guildCmds: ReturnType<Command['data']['toJSON']>[] = [];
  for (const cmd of client.commands.values()) {
    const source = client.commandSources?.get(cmd.data.name) ?? undefined;
    const cls = classifyCommand({
      name: cmd.data.name,
      source,
      adminOnly: cmd.adminOnly,
      devOnly: cmd.devOnly,
      manufacturerOnly: cmd.manufacturerOnly,
    });
    if (!cls.staysInDiscord) continue;

    const json = cmd.data.toJSON();
    if (cls.category === 'admin' || cls.category === 'dev') globalCmds.push(json);
    else guildCmds.push(json);
  }
  return { global: globalCmds, guild: guildCmds };
}

/**
 * Registriert die Commands scope-getrennt. Die globalen und Guild-Sets werden
 * jeweils vollstaendig ersetzt, sodass keine alten Discord-Registrierungen
 * zurueckbleiben.
 */
export async function deployCommandsScoped(
  client: ExtendedClient,
  token: string,
  clientId: string,
  guildIds: string[],
): Promise<{ globalCount: number; guildCount: number; guildsOk: number }> {
  const rest = new REST({ version: '10' }).setToken(token);
  const { global: globalCmds, guild: guildCmds } = splitCommandsByScope(client);

  await rest.put(Routes.applicationCommands(clientId), { body: globalCmds });
  logger.info(`${globalCmds.length} erhaltene globale Discord-Commands registriert.`);

  let guildsOk = 0;
  for (const gid of guildIds) {
    try {
      await rest.put(Routes.applicationGuildCommands(clientId, gid), { body: guildCmds });
      guildsOk++;
    } catch (e) {
      logger.warn(`Guild-Deploy fuer ${gid} fehlgeschlagen:`, e as Error);
    }
  }
  logger.info(`${guildCmds.length} guild-Commands auf ${guildsOk}/${guildIds.length} Guild(s) registriert.`);
  return { globalCount: globalCmds.length, guildCount: guildCmds.length, guildsOk };
}

/** Registriert die guild-scoped Commands fuer genau eine Guild. */
export async function deployGuildCommands(
  client: ExtendedClient,
  token: string,
  clientId: string,
  guildId: string,
): Promise<number> {
  const rest = new REST({ version: '10' }).setToken(token);
  const { guild: guildCmds } = splitCommandsByScope(client);
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: guildCmds });
  return guildCmds.length;
}
