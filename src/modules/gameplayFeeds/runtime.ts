/**
 * Gameplay-Feed Runtime V2.
 *
 * Source-of-Truth ist AdmEvent. Pro Config wird ein persistenter Scan-Cursor
 * gefuehrt, wodurch neue Events auch bei >200/1000 Historieneintraegen sicher
 * erreicht werden. Discord-Zustellungen besitzen Lease/Retry und werden nach
 * einem Crash anhand des Event-Markers in den letzten Channel-Nachrichten
 * reconciled, bevor erneut gepostet wird.
 */

import {
  AdmEventType,
  GameplayDeliveryStatus,
  GameplayFeedKind,
  type GameplayFeedConfig,
  type GameplayFeedDelivery,
} from '@prisma/client';
import type { GuildTextBasedChannel } from 'discord.js';
import prisma from '../../database/prisma';
import { logger } from '../../utils/logger';
import { tryGetDashboardClient } from '../../dashboard/clientRegistry';
import { emitServerGameplayEvent } from '../../dashboard/socket/emitter';
import { buildGameplayFeedEmbed, gameplayEventMarker } from './embedBuilder';
import {
  BUILD_EVENT_TYPES,
  DEATH_EVENT_TYPES,
  categoryAllowed,
  deriveGameplayFeedView,
  type GameplayAdmEvent,
} from './types';

const POLL_INTERVAL_MS = 15_000;
const LEASE_MS = 60_000;
const MAX_ATTEMPTS = 8;
const SCAN_BATCH = 200;
const MAX_SCAN_BATCHES_PER_TICK = 5;
const DELIVERY_BATCH = 50;

let timer: NodeJS.Timeout | null = null;
let running = false;

function retryDelayMs(attempt: number): number {
  return Math.min(15 * 60_000, 15_000 * Math.pow(2, Math.max(0, attempt - 1)));
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]').slice(0, 1000);
}

function eventTypes(kind: GameplayFeedKind): AdmEventType[] {
  return (kind === GameplayFeedKind.DEATH ? [...DEATH_EVENT_TYPES] : [...BUILD_EVENT_TYPES]) as AdmEventType[];
}

async function createDeliveryIfNeeded(config: GameplayFeedConfig, event: GameplayAdmEvent): Promise<void> {
  if (!categoryAllowed(config.kind, config.categories, event.eventType)) return;
  try {
    await prisma.gameplayFeedDelivery.create({
      data: {
        configId: config.id,
        admEventId: event.id,
        guildId: config.guildId,
        nitradoConnId: config.nitradoConnId,
        channelId: config.channelId,
        status: GameplayDeliveryStatus.PENDING,
      },
    });
  } catch (error) {
    if ((error as { code?: string }).code !== 'P2002') throw error;
  }
}

/** Scannt ausschliesslich hinter dem persistenten High-Watermark. */
async function enqueueNewEvents(config: GameplayFeedConfig): Promise<void> {
  let cursorCreatedAt = config.cursorCreatedAt;
  let cursorEventId = config.cursorEventId;

  for (let batchNo = 0; batchNo < MAX_SCAN_BATCHES_PER_TICK; batchNo++) {
    const events = await prisma.admEvent.findMany({
      where: {
        guildId: config.guildId,
        nitradoConnId: config.nitradoConnId,
        eventType: { in: eventTypes(config.kind) },
        OR: [
          { createdAt: { gt: cursorCreatedAt } },
          { createdAt: cursorCreatedAt, id: { gt: cursorEventId } },
        ],
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: SCAN_BATCH,
      select: {
        id: true,
        eventType: true,
        occurredAt: true,
        createdAt: true,
        actorGameId: true,
        actorName: true,
        targetGameId: true,
        targetName: true,
        objectType: true,
        toolOrWeapon: true,
        distanceMeters: true,
        actorPosition: true,
        targetPosition: true,
      },
    }) as GameplayAdmEvent[];

    if (events.length === 0) break;
    for (const event of events) await createDeliveryIfNeeded(config, event);

    const last = events[events.length - 1];
    cursorCreatedAt = last.createdAt;
    cursorEventId = last.id;
    await prisma.gameplayFeedConfig.updateMany({
      where: {
        id: config.id,
        guildId: config.guildId,
        nitradoConnId: config.nitradoConnId,
        kind: config.kind,
      },
      data: { cursorCreatedAt, cursorEventId },
    });

    if (events.length < SCAN_BATCH) break;
  }
}

async function findExistingDiscordMessage(
  channel: GuildTextBasedChannel,
  eventId: string,
): Promise<string | null> {
  try {
    const messages = await channel.messages.fetch({ limit: 50 });
    const marker = gameplayEventMarker(eventId);
    for (const message of messages.values()) {
      if (message.author.id !== channel.client.user.id) continue;
      if (message.embeds.some(embed => embed.footer?.text?.includes(marker))) return message.id;
    }
  } catch {
    // Der normale Send-Pfad darf nicht an einer best-effort Reconciliation
    // scheitern. Die Route fordert ReadMessageHistory bereits bei Config an.
  }
  return null;
}

async function markSent(
  config: GameplayFeedConfig,
  delivery: GameplayFeedDelivery,
  event: GameplayAdmEvent,
  messageId: string,
): Promise<void> {
  const now = new Date();
  await prisma.$transaction([
    prisma.gameplayFeedDelivery.updateMany({
      where: {
        id: delivery.id,
        configId: config.id,
        guildId: config.guildId,
        nitradoConnId: config.nitradoConnId,
        status: GameplayDeliveryStatus.SENDING,
      },
      data: {
        status: GameplayDeliveryStatus.SENT,
        messageId,
        sentAt: now,
        leaseUntil: null,
        lastError: null,
      },
    }),
    prisma.gameplayFeedConfig.updateMany({
      where: { id: config.id, guildId: config.guildId, nitradoConnId: config.nitradoConnId },
      data: { lastEventAt: event.occurredAt ?? now, lastErrorMsg: null, lastPolledAt: now },
    }),
  ]);
}

async function failDelivery(
  config: GameplayFeedConfig,
  delivery: GameplayFeedDelivery,
  error: unknown,
): Promise<void> {
  const message = safeError(error);
  const attempts = delivery.attempts + 1;
  const failed = attempts >= MAX_ATTEMPTS;
  await prisma.$transaction([
    prisma.gameplayFeedDelivery.updateMany({
      where: {
        id: delivery.id,
        configId: config.id,
        guildId: config.guildId,
        nitradoConnId: config.nitradoConnId,
        status: GameplayDeliveryStatus.SENDING,
      },
      data: {
        status: failed ? GameplayDeliveryStatus.FAILED : GameplayDeliveryStatus.RETRY,
        attempts,
        nextAttemptAt: new Date(Date.now() + retryDelayMs(attempts)),
        leaseUntil: null,
        lastError: message,
      },
    }),
    prisma.gameplayFeedConfig.updateMany({
      where: { id: config.id, guildId: config.guildId, nitradoConnId: config.nitradoConnId },
      data: { lastErrorMsg: message, lastPolledAt: new Date() },
    }),
  ]);
}

async function deliverOne(
  config: GameplayFeedConfig,
  alias: string,
  delivery: GameplayFeedDelivery,
): Promise<void> {
  const claimed = await prisma.gameplayFeedDelivery.updateMany({
    where: {
      id: delivery.id,
      configId: config.id,
      guildId: config.guildId,
      nitradoConnId: config.nitradoConnId,
      status: { in: [GameplayDeliveryStatus.PENDING, GameplayDeliveryStatus.RETRY] },
      nextAttemptAt: { lte: new Date() },
    },
    data: {
      status: GameplayDeliveryStatus.SENDING,
      leaseUntil: new Date(Date.now() + LEASE_MS),
    },
  });
  if (claimed.count !== 1) return;

  const claimedDelivery = { ...delivery, status: GameplayDeliveryStatus.SENDING } as GameplayFeedDelivery;
  try {
    const event = await prisma.admEvent.findFirst({
      where: {
        id: delivery.admEventId,
        guildId: config.guildId,
        nitradoConnId: config.nitradoConnId,
      },
      select: {
        id: true,
        eventType: true,
        occurredAt: true,
        createdAt: true,
        actorGameId: true,
        actorName: true,
        targetGameId: true,
        targetName: true,
        objectType: true,
        toolOrWeapon: true,
        distanceMeters: true,
        actorPosition: true,
        targetPosition: true,
      },
    }) as GameplayAdmEvent | null;
    if (!event) throw new Error('ADM-Ereignis fuer Feed-Zustellung nicht mehr vorhanden');
    if (!categoryAllowed(config.kind, config.categories, event.eventType)) {
      // Config wurde nach dem Enqueue geaendert: nicht mehr gewuenschte Events
      // gelten als bewusst uebersprungen und werden nicht erneut versucht.
      await prisma.gameplayFeedDelivery.updateMany({
        where: { id: delivery.id, configId: config.id, status: GameplayDeliveryStatus.SENDING },
        data: { status: GameplayDeliveryStatus.SENT, sentAt: new Date(), leaseUntil: null, lastError: 'Skipped after config filter change' },
      });
      return;
    }

    const client = tryGetDashboardClient();
    if (!client) throw new Error('Discord-Client nicht verfuegbar');
    const channel = await client.channels.fetch(config.channelId).catch(() => null);
    if (!channel || !channel.isTextBased() || channel.isDMBased()) throw new Error('Feed-Channel nicht verfuegbar/Text-Channel');
    const textChannel = channel as GuildTextBasedChannel;
    if (textChannel.guildId !== config.guildId) throw new Error('Feed-Channel gehoert nicht zur Guild');

    // Bei Retry zuerst nach einem bereits gesendeten Marker suchen. Das
    // schliesst das Crash-Fenster "Discord send erfolgreich, DB-Commit fehlt".
    if (delivery.attempts > 0 || delivery.lastError) {
      const existingMessageId = await findExistingDiscordMessage(textChannel, event.id);
      if (existingMessageId) {
        await markSent(config, claimedDelivery, event, existingMessageId);
        return;
      }
    }

    const view = deriveGameplayFeedView(event, {
      showActorCoords: config.showActorCoords,
      showTargetCoords: config.showTargetCoords,
      showTool: config.showTool,
      showDistance: config.showDistance,
    });
    if (!view) throw new Error(`Nicht unterstuetzter Gameplay-Eventtyp: ${event.eventType}`);

    const message = await textChannel.send({
      embeds: [buildGameplayFeedEmbed(view, config.embedColor, alias)],
      allowedMentions: { parse: [] },
    });
    await markSent(config, claimedDelivery, event, message.id);

    emitServerGameplayEvent({
      guildId: config.guildId,
      nitradoConnId: config.nitradoConnId,
      eventId: event.id,
      source: 'ADM_V2',
      eventType: event.eventType,
      occurredAt: event.occurredAt?.toISOString() ?? null,
      actorName: event.actorName,
      targetName: event.targetName,
      weapon: view.toolOrWeapon,
      distance: view.distanceMeters,
      actorPosition: view.actorPosition,
      targetPosition: view.targetPosition,
    });
  } catch (error) {
    await failDelivery(config, claimedDelivery, error);
  }
}

async function processConfig(config: GameplayFeedConfig): Promise<void> {
  const connection = await prisma.nitradoConnection.findFirst({
    where: {
      id: config.nitradoConnId,
      guildId: config.guildId,
      status: 'ACTIVE',
      nitradoServerId: { not: null },
    },
    select: { alias: true },
  });
  if (!connection) {
    await prisma.gameplayFeedConfig.updateMany({
      where: { id: config.id, guildId: config.guildId, nitradoConnId: config.nitradoConnId },
      data: { lastPolledAt: new Date(), lastErrorMsg: 'Nitrado-Verbindung nicht aktiv/gebunden' },
    });
    return;
  }

  try {
    await enqueueNewEvents(config);
    const due = await prisma.gameplayFeedDelivery.findMany({
      where: {
        configId: config.id,
        guildId: config.guildId,
        nitradoConnId: config.nitradoConnId,
        status: { in: [GameplayDeliveryStatus.PENDING, GameplayDeliveryStatus.RETRY] },
        nextAttemptAt: { lte: new Date() },
      },
      orderBy: [{ nextAttemptAt: 'asc' }, { createdAt: 'asc' }],
      take: DELIVERY_BATCH,
    });
    for (const delivery of due) await deliverOne(config, connection.alias, delivery);
    await prisma.gameplayFeedConfig.updateMany({
      where: { id: config.id, guildId: config.guildId, nitradoConnId: config.nitradoConnId },
      data: { lastPolledAt: new Date() },
    });
  } catch (error) {
    const message = safeError(error);
    logger.warn(`GameplayFeed ${config.id}: ${message}`);
    await prisma.gameplayFeedConfig.updateMany({
      where: { id: config.id, guildId: config.guildId, nitradoConnId: config.nitradoConnId },
      data: { lastPolledAt: new Date(), lastErrorMsg: message },
    });
  }
}

export async function runGameplayFeedsOnce(): Promise<void> {
  if (running) return;
  running = true;
  try {
    // Globaler Recovery-Sweep; jede spaetere Zustellung ist wieder strikt an
    // configId+guildId+nitradoConnId gebunden.
    // eslint-disable-next-line local/no-unscoped-prisma-query -- globaler Lease-Recovery-Sweep
    await prisma.gameplayFeedDelivery.updateMany({
      where: {
        status: GameplayDeliveryStatus.SENDING,
        leaseUntil: { lt: new Date() },
      },
      data: {
        status: GameplayDeliveryStatus.RETRY,
        attempts: { increment: 1 },
        nextAttemptAt: new Date(),
        leaseUntil: null,
        lastError: 'Delivery lease expired; reconciliation required',
      },
    });

    // eslint-disable-next-line local/no-unscoped-prisma-query -- Scheduler iteriert aktive Configs; processConfig scoped jede Folgequery
    const configs = await prisma.gameplayFeedConfig.findMany({
      where: { isActive: true },
      orderBy: { createdAt: 'asc' },
    });
    for (const config of configs) await processConfig(config);
  } catch (error) {
    logger.error('GameplayFeed-Worker Fehler:', error as Error);
  } finally {
    running = false;
  }
}

export function startGameplayFeedRuntime(): void {
  if (timer) return;
  timer = setInterval(() => { void runGameplayFeedsOnce(); }, POLL_INTERVAL_MS);
  timer.unref?.();
  void runGameplayFeedsOnce();
}

export function stopGameplayFeedRuntime(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
