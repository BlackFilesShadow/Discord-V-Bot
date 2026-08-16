import { Client, Collection, GatewayIntentBits, Partials } from 'discord.js';
import { ExtendedClient, BotEvent } from './types';
import { config } from './config';
import { loadCommands, deployCommandsScoped, deployGuildCommands } from './commands/handler';
import { logger } from './utils/logger';
import prisma from './database/prisma';
import fs from 'fs';

import readyEvent from './events/ready';
import interactionCreateEvent from './events/interactionCreate';
import guildMemberAddEvent from './events/guildMemberAdd';
import guildMemberRemoveEvent from './events/guildMemberRemove';
import messageCreateEvent from './events/messageCreate';
import messageReactionAddEvent from './events/messageReactionAdd';
import messageReactionRemoveEvent from './events/messageReactionRemove';
import voiceStateUpdateEvent from './events/voiceStateUpdate';

import { startGiveawayScheduler, stopGiveawayScheduler } from './modules/giveaway/giveawayManager';
import { startLotteryScheduler, stopLotteryScheduler } from './modules/economy/lottery';
import { startFeedScheduler, stopFeedScheduler } from './modules/feeds/feedManager';
import { startPollScheduler, stopPollScheduler } from './modules/polls/pollSystem';
import { startRateLimitCleanup, stopRateLimitCleanup } from './utils/rateLimiter';
import { startReminderScheduler, stopReminderScheduler } from './modules/reminders/reminderScheduler';
import { startDashboard } from './dashboard/server';
import { processExpiredCasesSafely } from './modules/moderation/caseExpiry';
import { acquireSingletonLock } from './utils/singleton';
import { assertProductionEnv } from './utils/envValidation';
import { startNitradoRuntime, type NitradoRuntimeHandle } from './modules/nitrado/runtime';
import { startAiBackgroundLoops, stopAiBackgroundLoops } from './modules/ai/runtime';
import { BOT_PRODUCT_NAME } from './content/botInfo';

/** Haupteinstiegspunkt fuer V-Bot Prime. */
async function main(): Promise<void> {
  logger.info(`${BOT_PRODUCT_NAME} startet...`);

  assertProductionEnv();

  if (!fs.existsSync(config.upload.dir)) {
    fs.mkdirSync(config.upload.dir, { recursive: true });
    logger.info(`Upload-Verzeichnis erstellt: ${config.upload.dir}`);
  }

  try {
    await prisma.$connect();
    logger.info('Datenbankverbindung hergestellt.');
  } catch (error) {
    logger.error('Datenbankverbindung fehlgeschlagen:', error);
    process.exit(1);
  }

  await acquireSingletonLock();

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
  await loadCommands(client);

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
  //  - GLOBAL: nur bewusst in Discord erhaltene globale Spezialfunktionen,
  //    insbesondere Hersteller/Hersteller-DEV.
  //  - GUILD: normale Community-/Gameserver-Commands pro Server.
  //  - Bot-Admin/DEV-Verwaltung: Dashboard-only und deshalb nicht registriert.
  client.once('clientReady', async () => {
    try {
      const guildIds = [...client.guilds.cache.keys()];
      logger.info(`Command-Sync (scoped) startet für ${guildIds.length} Guild(s)...`);
      const res = await deployCommandsScoped(client, config.discord.token, config.discord.clientId, guildIds);
      if (res.guildsFailed > 0) {
        logger.error(`Command-Sync unvollständig: ${res.globalCount} global, ${res.guildCount} guild-scoped; ${res.guildsOk}/${guildIds.length} Guild(s) erfolgreich.`, {
          failedGuildIds: res.failedGuildIds,
        });
      } else {
        logger.info(`Command-Sync fertig: ${res.globalCount} global, ${res.guildCount} guild-scoped auf ${res.guildsOk} Guild(s).`);
      }
    } catch (e) {
      logger.error('Per-Guild Command-Sync Fehler:', e);
    }

    // AI-Hintergrundlogik darf nicht an einem transienten Discord-Command-
    // Deploy fuer eine einzelne Guild haengen. Der Deploy-Fehler bleibt oben
    // sichtbar/operativ fehlerhaft, waehrend die unabhaengige Runtime startet.
    try {
      await startAiBackgroundLoops(client);
    } catch (e) {
      logger.error('AI-Hintergrundruntime konnte nicht gestartet werden:', e);
    }
  });

  // Bei Beitritt zu einer neuen Guild werden nur die guild-scoped normalen
  // Commands registriert; die erhaltenen globalen Spezialcommands existieren bereits.
  client.on('guildCreate', async (guild) => {
    try {
      const n = await deployGuildCommands(client, config.discord.token, config.discord.clientId, guild.id);
      logger.info(`Bot beigetreten zu ${guild.name} (${guild.id}) – ${n} Guild-Commands registriert`);
    } catch (e) {
      logger.warn(`guildCreate Command-Deploy für ${guild.id} fehlgeschlagen:`, e as Error);
    }
    try {
      const { syncGuild } = await import('./modules/ai/guildAwareness.js');
      await syncGuild(guild);
    } catch (e) {
      logger.warn(`GuildAwareness-Sync für ${guild.id} fehlgeschlagen:`, e as Error);
    }
    try {
      const { getOrCreate: getOrCreateLink } = await import('./modules/dashboard/repository.js');
      const { asGuildId, asUserDiscordId } = await import('./types/scope.js');
      const link = await getOrCreateLink(asGuildId(guild.id), asUserDiscordId(guild.ownerId));
      const dashboardBase = config.dashboard.url ?? `http://localhost:${config.dashboard.port}`;
      const url = `${dashboardBase.replace(/\/$/, '')}/servers/${guild.id}`;
      try {
        const owner = await guild.fetchOwner();
        await owner.send(
          `Vielen Dank, dass du **${BOT_PRODUCT_NAME}** zu **${guild.name}** hinzugefuegt hast!\n` +
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

  client.on('guildUpdate', async (_oldGuild, newGuild) => {
    try {
      const { syncGuild } = await import('./modules/ai/guildAwareness.js');
      await syncGuild(newGuild);
    } catch (e) {
      logger.warn(`GuildAwareness-Update für ${newGuild.id} fehlgeschlagen:`, e as Error);
    }
  });

  await client.login(config.discord.token);

  let dashboardRuntime: Awaited<ReturnType<typeof startDashboard>> | null = null;
  try {
    dashboardRuntime = await startDashboard(client);
  } catch (error) {
    // Bot-Admin und DEV sind nach der Command-Migration dashboard-only. Ein
    // Prozess ohne Dashboard waere daher funktional unvollstaendig und darf
    // nicht als produktionsbereit weiterlaufen.
    logger.error('Dashboard konnte nicht gestartet werden; Start wird abgebrochen:', error);
    client.destroy();
    await prisma.$disconnect().catch(() => undefined);
    throw error;
  }

  let nitradoRuntime: NitradoRuntimeHandle | null = null;
  try {
    nitradoRuntime = startNitradoRuntime(client);
  } catch (e) {
    logger.warn('Nitrado-Worker-Init fehlgeschlagen:', e as Error);
  }

  startGiveawayScheduler(client);
  startLotteryScheduler(client);
  startFeedScheduler(client);
  startPollScheduler(client);
  startRateLimitCleanup();
  startReminderScheduler(client);

  const moderationTimer = setInterval(async () => {
    try {
      for (const guild of client.guilds.cache.values()) {
        const n = await processExpiredCasesSafely(guild);
        if (n > 0) logger.info(`Moderation: ${n} abgelaufene Cases aufgehoben (Guild ${guild.id}).`);
      }
    } catch (err) {
      logger.error('Moderation-Scheduler Fehler:', err as Error);
    }
  }, 60_000);
  moderationTimer.unref?.();

  logger.info(`${BOT_PRODUCT_NAME} vollständig gestartet.`);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} empfangen. Fahre herunter...`);
    const watchdog = setTimeout(() => {
      logger.error('Shutdown-Watchdog: erzwinge Beenden nach Timeout.');
      process.exit(1);
    }, 20_000);
    watchdog.unref?.();

    try {
      if (dashboardRuntime) await dashboardRuntime.stop();
    } catch (e) {
      logger.warn('Dashboard-Runtime-Shutdown fehlgeschlagen:', e as Error);
    }

    stopAiBackgroundLoops();
    clearInterval(moderationTimer);
    stopReminderScheduler();
    stopRateLimitCleanup();
    stopPollScheduler();
    stopFeedScheduler();
    stopGiveawayScheduler();
    stopLotteryScheduler();

    try {
      if (nitradoRuntime) await nitradoRuntime.stopAndDrain();
    } catch (e) {
      logger.warn('Nitrado-Runtime-Shutdown fehlgeschlagen:', e as Error);
    }

    await client.destroy();
    await prisma.$disconnect();
    clearTimeout(watchdog);
    logger.info(`${BOT_PRODUCT_NAME} heruntergefahren.`);
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
