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
  ];

  for (const dir of commandDirs) {
    if (!fs.existsSync(dir)) continue;

    const files = fs.readdirSync(dir).filter(f => f.endsWith('.ts') || f.endsWith('.js'));

    for (const file of files) {
      try {
        const commandModule = await import(path.join(dir, file));

        // Default export
        if (commandModule.default?.data?.name) {
          const command: Command = commandModule.default;
          client.commands.set(command.data.name, command);
          logger.info(`Command geladen: /${command.data.name}`);
        } else {
          // Named exports (z.B. moderation.ts mit kickCommand, banCommand, etc.)
          for (const key of Object.keys(commandModule)) {
            const exported = commandModule[key];
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
 */
export async function deployCommands(client: ExtendedClient, token: string, clientId: string, guildId?: string): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(token);

  const commandData = client.commands.map(c => c.data.toJSON());

  try {
    if (guildId) {
      // Guild-spezifisch (schneller, für Entwicklung)
      await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
        body: commandData,
      });
      logger.info(`${commandData.length} Commands auf Guild ${guildId} registriert.`);
    } else {
      // Global
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
