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
 * Koordinierte oeffentliche Command-Namensmigration.
 *
 * Die Legacy-Implementierungen bleiben intern unveraendert, aber bereits beim
 * atomaren Loader-Snapshot werden die Builder auf die kanonischen Namen
 * umgestellt. Dadurch verwenden Runtime-Registry, Discord-Deploy, /help und
 * Dashboard-Katalog ausnahmslos dieselben Namen und die alten Aliase werden
 * nicht parallel registriert.
 */
export const PUBLIC_COMMAND_RENAMES: Readonly<Record<string, string>> = Object.freeze({
  whitelist: 'whitelist-antrag',
  'wl-add': 'whitelist-add',
  'wl-remove': 'whitelist-remove',
  'wl-list': 'whitelist',
});

/**
 * Economy enthaelt aus historischen Gruenden noch die alten Link-Exports.
 * Seit dem Konsolen-Linking liegen /link, /unlink und /links kanonisch in
 * dashboard/linking.ts. Der Loader verwirft ausschliesslich diese drei alten
 * Export-Symbole, damit niemals zwei Implementierungen desselben Slash-Commands
 * parallel registriert werden.
 */
const SUPERSEDED_COMMAND_EXPORTS = new Set([
  'dashboard/economy#linkCommand',
  'dashboard/economy#unlinkCommand',
  'dashboard/economy#linksCommand',
]);

function normalizedSourceModule(sourceFile: string): string {
  return sourceFile.replace(/\\/g, '/').replace(/\.(?:ts|js)$/i, '');
}

export function isSupersededCommandExport(sourceFile: string, exportName: string): boolean {
  return SUPERSEDED_COMMAND_EXPORTS.has(`${normalizedSourceModule(sourceFile)}#${exportName}`);
}

export function canonicalDiscordCommandName(name: string): string {
  return PUBLIC_COMMAND_RENAMES[name] ?? name;
}

function canonicalizeCommandName(command: Command): Command {
  const current = command.data.name;
  const canonical = canonicalDiscordCommandName(current);
  if (canonical !== current) command.data.setName(canonical);
  return command;
}

/**
 * Command-Handler: Laedt alle Slash-Commands atomar in eine neue Collection.
 * Die aktive Runtime-Registry wird erst ersetzt, wenn der komplette Loader-
 * Durchlauf erfolgreich beendet ist. Im Standardmodus verwirft jeder
 * Modul-/Registryfehler den neuen Snapshot; nur COMMAND_LOADER_STRICT=false
 * erlaubt den explizit toleranten Legacy-Modus.
 */
export async function loadCommands(client: ExtendedClient): Promise<void> {
  const nextCommands = new Collection<string, Command>();
  const commandSources = new Map<string, string>();
  let collisionCount = 0;
  const strict = process.env.COMMAND_LOADER_STRICT !== 'false';

  const registerCommand = (rawCommand: Command, sourceFile: string): void => {
    const cmd = canonicalizeCommandName(rawCommand);
    const existing = commandSources.get(cmd.data.name);
    if (existing && existing !== sourceFile) {
      collisionCount++;
      const base = `[Command-Collision] /${cmd.data.name} ist doppelt definiert: ` +
        `"${existing}" und "${sourceFile}".`;
      if (strict) {
        logger.error(`${base} Abbruch (setze COMMAND_LOADER_STRICT=false zum Tolerieren).`);
        throw new CommandCollisionError(`Command-Collision: /${cmd.data.name} in "${existing}" und "${sourceFile}"`);
      }
      logger.warn(`${base} Letztere ueberschreibt erstere (COMMAND_LOADER_STRICT=false).`);
    }
    commandSources.set(cmd.data.name, sourceFile);
    nextCommands.set(cmd.data.name, cmd);
  };

  const commandDirs = [
    path.join(__dirname, 'user'),
    path.join(__dirname, 'admin'),
    path.join(__dirname, 'developer'),
    path.join(__dirname, 'dashboard'),
  ];

  for (const dir of commandDirs) {
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter(file => file.endsWith('.ts') || file.endsWith('.js'));

    for (const file of files) {
      const relSource = path.join(path.basename(dir), file);
      try {
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
            if (isSupersededCommandExport(relSource, key)) {
              logger.info(`Legacy-Command-Export ${normalizedSourceModule(relSource)}#${key} wird durch dashboard/linking ersetzt.`);
              continue;
            }
            const exported = source[key];
            if (exported?.data?.name && typeof exported.execute === 'function') {
              const command = exported as Command;
              registerCommand(command, relSource);
              logger.info(`Command geladen: /${command.data.name}`);
            }
          }
        }
      } catch (error) {
        if (error instanceof CommandCollisionError) throw error;
        logger.error(`Fehler beim Laden von Command ${file}:`, error);
        if (strict) {
          throw error instanceof Error
            ? error
            : new Error(`Unbekannter Fehler beim Laden von Command ${relSource}`);
        }
        logger.warn(`Command ${relSource} wurde nur wegen COMMAND_LOADER_STRICT=false uebersprungen.`);
      }
    }
  }

  if (collisionCount > 0) {
    logger.warn(`[Command-Collision] ${collisionCount} doppelte Command-Name(n) erkannt.`);
  }

  client.commands = nextCommands;
  client.commandSources = commandSources;
  client.commandCollisions = collisionCount;
  logger.info(`${client.commands.size} Commands geladen.`);
}

/** Registriert alle geladenen Commands in genau einem Discord-Scope. */
export async function deployCommands(client: ExtendedClient, token: string, clientId: string, guildId?: string): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(token);
  const commandData = client.commands.map(command => command.data.toJSON());
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

export function splitCommandsByScope(client: ExtendedClient): {
  global: ReturnType<Command['data']['toJSON']>[];
  guild: ReturnType<Command['data']['toJSON']>[];
} {
  const globalCmds: ReturnType<Command['data']['toJSON']>[] = [];
  const guildCmds: ReturnType<Command['data']['toJSON']>[] = [];
  for (const cmd of client.commands.values()) {
    const source = client.commandSources?.get(cmd.data.name) ?? undefined;
    const classification = classifyCommand({
      name: cmd.data.name,
      source,
      adminOnly: cmd.adminOnly,
      devOnly: cmd.devOnly,
      manufacturerOnly: cmd.manufacturerOnly,
    });
    if (!classification.staysInDiscord) continue;

    const json = cmd.data.toJSON();
    if (classification.category === 'admin' || classification.category === 'dev') globalCmds.push(json);
    else guildCmds.push(json);
  }
  return { global: globalCmds, guild: guildCmds };
}

export interface ScopedDeployResult {
  globalCount: number;
  guildCount: number;
  guildsOk: number;
  guildsFailed: number;
  failedGuildIds: string[];
}

export async function deployCommandsScoped(
  client: ExtendedClient,
  token: string,
  clientId: string,
  guildIds: string[],
): Promise<ScopedDeployResult> {
  const rest = new REST({ version: '10' }).setToken(token);
  const { global: globalCmds, guild: guildCmds } = splitCommandsByScope(client);

  await rest.put(Routes.applicationCommands(clientId), { body: globalCmds });
  logger.info(`${globalCmds.length} erhaltene globale Discord-Commands registriert.`);

  let guildsOk = 0;
  const failedGuildIds: string[] = [];
  for (const guildId of guildIds) {
    try {
      await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: guildCmds });
      guildsOk++;
    } catch (error) {
      failedGuildIds.push(guildId);
      logger.warn(`Guild-Deploy fuer ${guildId} fehlgeschlagen:`, error as Error);
    }
  }
  logger.info(`${guildCmds.length} guild-Commands auf ${guildsOk}/${guildIds.length} Guild(s) registriert.`);
  return {
    globalCount: globalCmds.length,
    guildCount: guildCmds.length,
    guildsOk,
    guildsFailed: failedGuildIds.length,
    failedGuildIds,
  };
}

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
