import { Client, Collection, GatewayIntentBits, Partials } from 'discord.js';
import { ExtendedClient, BotEvent } from './types';
import { config } from './config';
import { loadCommands, deployCommandsScoped, deployGuildCommands } from './commands/handler';
import { logger } from './utils/logger';
import prisma from './database/prisma';
import fs from 'fs';

// Events importieren
import readyEvent from './events/ready';
import interactionCreateEvent from './events/interactionCreate';
import guildMemberAddEvent from './events/guildMemberAdd';
import guildMemberRemoveEvent from './events/guildMemberRemove';
import messageCreateEvent from './events/messageCreate';
import messageReactionAddEvent from './events/messageReactionAdd';
import messageReactionRemoveEvent from './events/messageReactionRemove';
import voiceStateUpdateEvent from './events/voiceStateUpdate';

// Module importieren
import { startGiveawayScheduler } from './modules/giveaway/giveawayManager';
import { startFeedScheduler } from './modules/feeds/feedManager';
import { startPollScheduler } from './modules/polls/pollSystem';
import { startRateLimitCleanup } from './utils/rateLimiter';
import { startDashboard } from './dashboard/server';
import { processExpiredCases } from './modules/moderation/caseManager';
import { acquireSingletonLock } from './utils/singleton';

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

  // Singleton-Lock: Verhindert dass zwei Instanzen mit demselben Token laufen.
  await acquireSingletonLock();

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
    messageReactionRemoveEvent,
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

  // Command-Registrierung scope-getrennt:
  //  - GLOBAL:  Admin-, Dev- und Manufacturer-Commands (ueberall identisch).
  //  - GUILD:   alle uebrigen "normalen" Commands pro Server (instant sichtbar).
  // So ist jeder Command in GENAU einem Scope → keine Duplikate.
  // Listener MUSS vor client.login registriert werden, sonst verpassen wir das Ready-Event.
  client.once('clientReady', async () => {
    try {
      const guildIds = [...client.guilds.cache.keys()];
      logger.info(`Command-Sync (scoped) startet für ${guildIds.length} Guild(s)...`);
      const res = await deployCommandsScoped(client, config.discord.token, config.discord.clientId, guildIds);
      logger.info(`Command-Sync fertig: ${res.globalCount} global, ${res.guildCount} guild-scoped auf ${res.guildsOk} Guild(s).`);
      // Phase 6: Guild-Stammdaten cachen / persistieren
      try {
        const { bootstrapGuildAwareness, startContentSyncLoop } = await import('./modules/ai/guildAwareness.js');
        await bootstrapGuildAwareness(client);
        // Phase 7: Auto-Sync Channels/Rules alle 60 min
        startContentSyncLoop(client);
        // Phase 9 (RAG): pgvector pruefen + Embeddings fuer alle aktiven Snippets nachziehen.
        try {
          const { checkPgvectorAvailability, backfillEmbeddings } = await import('./modules/ai/embeddings.js');
          await checkPgvectorAvailability();
          void backfillEmbeddings().catch((e) => {
            logger.warn('Embedding-Backfill fehlgeschlagen:', e as Error);
          });
        } catch (e) {
          logger.warn('RAG-Initialisierung fehlgeschlagen:', e as Error);
        }
        // Phase 14 (Conversation Memory): Cleanup-Loop starten.
        try {
          const { startConversationCleanupLoop, cleanupOld } = await import('./modules/ai/conversationMemory.js');
          void cleanupOld();
          startConversationCleanupLoop();
        } catch (e) {
          logger.warn('ConversationMemory-Init fehlgeschlagen:', e as Error);
        }
        // Phase 17 (TranslatedPost-Scheduler): Polling-Loop starten.
        try {
          const { startTranslatedPostScheduler } = await import('./modules/ai/translatedPostScheduler.js');
          startTranslatedPostScheduler(client);
        } catch (e) {
          logger.warn('TranslatedPost-Scheduler-Init fehlgeschlagen:', e as Error);
        }
      } catch (e) {
        logger.warn('GuildAwareness-Bootstrap fehlgeschlagen:', e as Error);
      }
    } catch (e) {
      logger.error('Per-Guild Command-Sync Fehler:', e);
    }
  });

  // Wenn der Bot einem NEUEN Server beitritt: die "normalen" Commands guild-scoped
  // registrieren. Admin/Dev/Manufacturer sind global bereits verfuegbar.
  client.on('guildCreate', async (guild) => {
    try {
      const n = await deployGuildCommands(client, config.discord.token, config.discord.clientId, guild.id);
      logger.info(`Bot beigetreten zu ${guild.name} (${guild.id}) – ${n} Guild-Commands registriert`);
    } catch (e) {
      logger.warn(`guildCreate Command-Deploy für ${guild.id} fehlgeschlagen:`, e as Error);
    }
    // Phase 6: Stammdaten der neuen Guild persistieren
    try {
      const { syncGuild } = await import('./modules/ai/guildAwareness.js');
      await syncGuild(guild);
    } catch (e) {
      logger.warn(`GuildAwareness-Sync für ${guild.id} fehlgeschlagen:`, e as Error);
    }
    // Phase 3-Final: DashboardGuildLink upserten + Owner-DM mit Dashboard-URL
    try {
      const { getOrCreate: getOrCreateLink } = await import('./modules/dashboard/repository.js');
      const { asGuildId, asUserDiscordId } = await import('./types/scope.js');
      const link = await getOrCreateLink(asGuildId(guild.id), asUserDiscordId(guild.ownerId));
      const dashboardBase = config.dashboard.url ?? `http://localhost:${config.dashboard.port}`;
      const url = `${dashboardBase.replace(/\/$/, '')}/servers/${guild.id}`;
      try {
        const owner = await guild.fetchOwner();
        await owner.send(
          `Vielen Dank, dass du **V-Bot** zu **${guild.name}** hinzugefuegt hast!\n` +
          `Dashboard-Identifier: \`${link.alias5}\`\n` +
          `Direktlink: ${url}`,
        ).catch(() => undefined);
      } catch {
        // Owner nicht erreichbar — silent
      }
      logger.info(`DashboardGuildLink fuer ${guild.id} angelegt (alias5=${link.alias5})`);
    } catch (e) {
      logger.warn(`DashboardGuildLink-Init fuer ${guild.id} fehlgeschlagen:`, e as Error);
    }
  });

  // Bei Aenderungen an der Guild (Name, Owner, Beschreibung): Stammdaten aktualisieren
  client.on('guildUpdate', async (_oldGuild, newGuild) => {
    try {
      const { syncGuild } = await import('./modules/ai/guildAwareness.js');
      await syncGuild(newGuild);
    } catch (e) {
      logger.warn(`GuildAwareness-Update für ${newGuild.id} fehlgeschlagen:`, e as Error);
    }
  });

  // Bot einloggen
  await client.login(config.discord.token);

  // Web-Dashboard SOFORT nach Login starten, damit Healthcheck (/health) und
  // /metrics frueh verfuegbar sind. Der Command-Sync (scoped, im clientReady)
  // kann minutenlang dauern und darf den HTTP-Server nicht blockieren.
  try {
    await startDashboard(client);
  } catch (error) {
    logger.error('Dashboard konnte nicht gestartet werden:', error);
  }

  // Phase 3-Final: Hintergrund-Worker starten (NitradoJob-Outbox + Token/ADM-Crons).
  try {
    const { startNitradoJobWorker } = await import('./modules/nitrado/jobWorker.js');
    const { startTokenValidationCron } = await import('./modules/nitrado/tokenValidationCron.js');
    const { startAdmSyncCron } = await import('./modules/nitrado/admSyncCron.js');
    const { startPermaOnlyCron } = await import('./modules/nitrado/permaOnlyCron.js');
    const { startKillfeedWatcher } = await import('./modules/killfeed/admWatcher.js');
    startNitradoJobWorker();
    startTokenValidationCron(client);
    startAdmSyncCron();
    startPermaOnlyCron();
    startKillfeedWatcher();
  } catch (e) {
    logger.warn('Nitrado-Worker-Init fehlgeschlagen:', e as Error);
  }

  // Hinweis: Die Command-Registrierung (scoped: global + guild) erfolgt im
  // clientReady-Listener oben, sobald der Guild-Cache verfuegbar ist.

  // Scheduler starten
  startGiveawayScheduler(client);
  startFeedScheduler(client);
  startPollScheduler(client);
  startRateLimitCleanup();

  // Phase B: Reminder-Scheduler
  try {
    const { startReminderScheduler } = await import('./modules/reminders/reminderScheduler.js');
    startReminderScheduler(client);
  } catch (e) {
    logger.warn('Reminder-Scheduler-Init fehlgeschlagen:', e as Error);
  }

  // Moderation-Scheduler: Temp-Bans/Mutes alle 60s prüfen
  setInterval(async () => {
    try {
      for (const guild of client.guilds.cache.values()) {
        const n = await processExpiredCases(guild);
        if (n > 0) logger.info(`Moderation: ${n} abgelaufene Cases aufgehoben (Guild ${guild.id}).`);
      }
    } catch (err) {
      logger.error('Moderation-Scheduler Fehler:', err as Error);
    }
  }, 60_000);

  logger.info('Discord-V-Bot vollständig gestartet.');

  // Graceful Shutdown
  const shutdown = async (signal: string) => {
    logger.info(`${signal} empfangen. Fahre herunter...`);
    await client.destroy();
    await prisma.$disconnect();
    logger.info('Bot heruntergefahren.');
    process.exit(0);
  };

  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
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
