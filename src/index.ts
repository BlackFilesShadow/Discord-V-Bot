import { Client, Collection, GatewayIntentBits, Partials } from 'discord.js';
import { ExtendedClient, BotEvent } from './types';
import { config } from './config';
import { loadCommands, deployCommands } from './commands/handler';
import { logger } from './utils/logger';
import prisma from './database/prisma';
import path from 'path';
import fs from 'fs';

// Events importieren
import readyEvent from './events/ready';
import interactionCreateEvent from './events/interactionCreate';
import guildMemberAddEvent from './events/guildMemberAdd';
import guildMemberRemoveEvent from './events/guildMemberRemove';
import messageCreateEvent from './events/messageCreate';
import messageReactionAddEvent from './events/messageReactionAdd';
import voiceStateUpdateEvent from './events/voiceStateUpdate';

// Module importieren
import { startGiveawayScheduler } from './modules/giveaway/giveawayManager';
import { startFeedScheduler } from './modules/feeds/feedManager';
import { startPollScheduler } from './modules/polls/pollSystem';

/**
 * Discord-V-Bot Haupteinstiegspunkt.
 * Sektion 5: Discord-Bot-Framework mit Sharding und Skalierung.
 */
async function main(): Promise<void> {
  logger.info('Discord-V-Bot startet...');

  // Upload-Verzeichnis erstellen
  if (!fs.existsSync(config.upload.dir)) {
    fs.mkdirSync(config.upload.dir, { recursive: true });
    logger.info(`Upload-Verzeichnis erstellt: ${config.upload.dir}`);
  }

  // Datenbank-Verbindung prüfen
  try {
    await prisma.$connect();
    logger.info('Datenbankverbindung hergestellt.');
  } catch (error) {
    logger.error('Datenbankverbindung fehlgeschlagen:', error);
    process.exit(1);
  }

  // Client erstellen mit allen notwendigen Intents
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildPresences,
      GatewayIntentBits.GuildInvites,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [
      Partials.Message,
      Partials.Reaction,
      Partials.Channel,
      Partials.User,
      Partials.GuildMember,
    ],
  }) as ExtendedClient;

  client.commands = new Collection();

  // Commands laden
  await loadCommands(client);

  // Events registrieren
  const events: BotEvent[] = [
    readyEvent,
    interactionCreateEvent,
    guildMemberAddEvent,
    guildMemberRemoveEvent,
    messageCreateEvent,
    messageReactionAddEvent,
    voiceStateUpdateEvent,
  ];

  for (const event of events) {
    if (event.once) {
      client.once(event.name, (...args) => event.execute(...args));
    } else {
      client.on(event.name, (...args) => event.execute(...args));
    }
    logger.info(`Event registriert: ${event.name}${event.once ? ' (once)' : ''}`);
  }

  // Bot einloggen
  await client.login(config.discord.token);

  // Commands bei Discord registrieren
  await deployCommands(client, config.discord.token, config.discord.clientId, config.discord.guildId);

  // Scheduler starten
  startGiveawayScheduler(client);
  startFeedScheduler(client);
  startPollScheduler(client);

  logger.info('Discord-V-Bot vollständig gestartet.');

  // Graceful Shutdown
  const shutdown = async (signal: string) => {
    logger.info(`${signal} empfangen. Fahre herunter...`);
    client.destroy();
    await prisma.$disconnect();
    logger.info('Bot heruntergefahren.');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (error) => {
    logger.error('Unhandled Rejection:', error);
  });
  process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception:', error);
  });
}

main().catch(error => {
  logger.error('Kritischer Startfehler:', error);
  process.exit(1);
});
