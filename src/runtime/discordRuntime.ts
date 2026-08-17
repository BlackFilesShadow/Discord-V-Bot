import type { EventEmitter } from 'node:events';
import type { BotEvent } from '../types';
import { logger } from '../utils/logger';
import { discordGatewayEventCounter, errorCounter } from '../utils/metrics';

export type DiscordEventRegistrar = Pick<EventEmitter, 'on' | 'once' | 'off'>;
export type DiscordLifecycleRegistrar = Pick<EventEmitter, 'on' | 'off'>;

const eventRegistration = new WeakSet<object>();
const lifecycleRegistration = new WeakMap<object, DiscordLifecycleHandle>();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertUniqueEventNames(events: readonly BotEvent[]): void {
  const seen = new Set<string>();
  for (const event of events) {
    if (seen.has(event.name)) {
      throw new Error(`Discord-Event doppelt registriert: ${event.name}`);
    }
    seen.add(event.name);
  }
}

interface ListenerSpec {
  event: string;
  listener: (...args: unknown[]) => void;
}

/**
 * Registriert Domain-Events exakt einmal pro Client und kapselt jede synchrone
 * sowie asynchrone Handler-Exception. Ein einzelnes Discord-Event darf niemals
 * als unhandled rejection aus dem EventEmitter entweichen.
 *
 * Die Event-Liste wird vor dem ersten Side-Effect validiert. Falls eine
 * Registrierung unerwartet fehlschlaegt, werden bereits angehaengte Listener
 * wieder entfernt und der Client bleibt fuer einen sauberen Retry registrierbar.
 */
export function registerBotEventsSafely(client: DiscordEventRegistrar, events: readonly BotEvent[]): void {
  const key = client as object;
  if (eventRegistration.has(key)) return;

  assertUniqueEventNames(events);

  const attached: ListenerSpec[] = [];
  try {
    for (const event of events) {
      const listener = (...args: unknown[]) => {
        void Promise.resolve()
          .then(() => event.execute(...args))
          .catch((error: unknown) => {
            errorCounter.inc({ source: `discord_event_${event.name}` });
            logger.error(`Discord-Event ${event.name} fehlgeschlagen:`, error as Error);
          });
      };

      if (event.once) client.once(event.name, listener);
      else client.on(event.name, listener);
      attached.push({ event: event.name, listener });

      logger.info(`Event registriert: ${event.name}${event.once ? ' (once)' : ''}`);
    }
    eventRegistration.add(key);
  } catch (error) {
    for (const { event, listener } of attached) client.off(event, listener);
    eventRegistration.delete(key);
    throw error;
  }
}

export interface DiscordLifecycleHandle {
  stop(): void;
}

function collectionSize(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === 'object') {
    const size = (value as { size?: unknown }).size;
    if (typeof size === 'number' && Number.isFinite(size) && size >= 0) return size;
  }
  return 0;
}

/**
 * Beobachtet den Discord-Gateway-Lifecycle ohne eigene Reconnect-Schleife.
 * discord.js bleibt alleiniger Owner des Gateway-Reconnects; V-Bot protokolliert
 * Zustandswechsel und Fehler lediglich zentral und niedrig-kardinal.
 */
export function installDiscordLifecycleObservers(client: DiscordLifecycleRegistrar): DiscordLifecycleHandle {
  const key = client as object;
  const existing = lifecycleRegistration.get(key);
  if (existing) return existing;

  const listeners: ListenerSpec[] = [];
  const add = (event: string, listener: (...args: unknown[]) => void) => {
    client.on(event, listener);
    listeners.push({ event, listener });
  };

  add('error', (error) => {
    discordGatewayEventCounter.inc({ event: 'client_error' });
    errorCounter.inc({ source: 'discord_client' });
    logger.error('Discord Client Error:', error as Error);
  });

  add('warn', (warning) => {
    discordGatewayEventCounter.inc({ event: 'client_warn' });
    logger.warn(`Discord Client Warnung: ${errorMessage(warning)}`);
  });

  add('shardDisconnect', (event, shardId) => {
    discordGatewayEventCounter.inc({ event: 'shard_disconnect' });
    const close = event as { code?: number; reason?: string } | undefined;
    logger.warn(
      `Discord Gateway getrennt (shard=${String(shardId)}, code=${String(close?.code ?? 'n/a')}, reason=${close?.reason ?? 'n/a'}).`,
    );
  });

  add('shardReconnecting', (shardId) => {
    discordGatewayEventCounter.inc({ event: 'shard_reconnecting' });
    logger.warn(`Discord Gateway reconnect startet (shard=${String(shardId)}).`);
  });

  add('shardReady', (shardId, unavailableGuilds) => {
    discordGatewayEventCounter.inc({ event: 'shard_ready' });
    logger.info(
      `Discord Gateway bereit (shard=${String(shardId)}, unavailableGuilds=${collectionSize(unavailableGuilds)}).`,
    );
  });

  add('shardResume', (shardId, replayedEvents) => {
    discordGatewayEventCounter.inc({ event: 'shard_resume' });
    logger.info(`Discord Gateway Session fortgesetzt (shard=${String(shardId)}, replayed=${String(replayedEvents ?? 0)}).`);
  });

  add('shardError', (error, shardId) => {
    discordGatewayEventCounter.inc({ event: 'shard_error' });
    errorCounter.inc({ source: 'discord_shard' });
    logger.error(`Discord Gateway Fehler (shard=${String(shardId)}):`, error as Error);
  });

  let stopped = false;
  const handle: DiscordLifecycleHandle = {
    stop() {
      if (stopped) return;
      stopped = true;
      for (const { event, listener } of listeners) client.off(event, listener);
      lifecycleRegistration.delete(key);
    },
  };
  lifecycleRegistration.set(key, handle);
  return handle;
}
