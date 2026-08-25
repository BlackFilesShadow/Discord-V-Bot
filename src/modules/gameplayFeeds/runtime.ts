/**
 * Gameplay-Feed Runtime V2.
 *
 * Source-of-Truth ist AdmEvent. Pro Config wird ein persistenter Scan-Cursor
 * gefuehrt, wodurch neue Events auch bei >200/1000 Historieneintraegen sicher
 * erreicht werden. Discord-Zustellungen besitzen Lease/Retry und nutzen einen
 * stabilen Discord-Nonce pro ADM-Event, damit Retries keine sichtbaren
 * technischen Marker im Embed benoetigen.
 */

import { createHash } from 'node:crypto';
import {
  AdmEventType,
  GameplayDeliveryStatus,
  GameplayFeedKind,
  Prisma,
  type GameplayFeedConfig,
  type GameplayFeedDelivery,
} from '@prisma/client';
import type { GuildTextBasedChannel } from 'discord.js';
import prisma from '../../database/prisma';
import { logger } from '../../utils/logger';
import { tryGetDashboardClient } from '../../dashboard/clientRegistry';
import { emitServerGameplayEvent } from '../../dashboard/socket/emitter';
import { admBindingFileIdentityPrefix } from '../nitrado/adm/bindingState';
import { buildGameplayFeedEmbed } from './embedBuilder';
import {
  BUILD_EVENT_TYPES,
  DEATH_EVENT_TYPES,
  categoryAllowed,
  deriveGameplayFeedView,
  type GameplayAdmEvent,
} from './types';
import {
  buildPlayerListEmbeds,
  playerListStateHash,
  type PlayerListEntry,
} from './playerListEmbed';
import {
  attachCurrentPositions,
  resolveOnlinePresence,
  type PlayerPositionEvent,
  type PlayerPresenceEvent,
} from './playerListRoster';

const POLL_INTERVAL_MS = 15_000;
const LEASE_MS = 60_000;
const MAX_ATTEMPTS = 8;
const SCAN_BATCH = 200;
const MAX_SCAN_BATCHES_PER_TICK = 5;
const DELIVERY_BATCH = 1;
const DELIVERY_SPACING_MS = 12_000;

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
  if (kind === GameplayFeedKind.PLAYER_LIST) return [];
  return (kind === GameplayFeedKind.DEATH ? [...DEATH_EVENT_TYPES] : [...BUILD_EVENT_TYPES]) as AdmEventType[];
}

function eventNonce(eventId: string): string {
  // Discord erlaubt maximal 25 Zeichen. Prisma-CUIDs passen aktuell exakt in
  // dieses Limit; der Slice haelt die Zustellung auch fuer andere ID-Formate sicher.
  return eventId.slice(0, 25);
}

function playerListNonce(configId: string, stateHash: string, postKey = 'state'): string {
  return createHash('sha256')
    .update(`online-list\u0000${configId}\u0000${stateHash}\u0000${postKey}`)
    .digest('hex')
    .slice(0, 25);
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
      data: {
        lastErrorMsg: message,
        lastPolledAt: new Date(),
        nextDeliveryAt: new Date(Date.now() + DELIVERY_SPACING_MS),
      },
    }),
  ]);
}

async function deliverOne(
  config: GameplayFeedConfig,
  delivery: GameplayFeedDelivery,
  serverAlias: string,
): Promise<void> {
  const active = await prisma.gameplayFeedConfig.findFirst({
    where: {
      id: config.id,
      guildId: config.guildId,
      nitradoConnId: config.nitradoConnId,
      isActive: true,
    },
    select: { id: true },
  });
  if (!active) return;

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
      await prisma.gameplayFeedDelivery.updateMany({
        where: {
          id: delivery.id,
          configId: config.id,
          guildId: config.guildId,
          nitradoConnId: config.nitradoConnId,
          status: GameplayDeliveryStatus.SENDING,
        },
        data: {
          status: GameplayDeliveryStatus.SKIPPED,
          sentAt: null,
          messageId: null,
          leaseUntil: null,
          lastError: 'Skipped after config filter change',
        },
      });
      return;
    }

    const client = tryGetDashboardClient();
    if (!client) throw new Error('Discord-Client nicht verfuegbar');
    const channel = await client.channels.fetch(config.channelId).catch(() => null);
    if (!channel || !channel.isTextBased() || channel.isDMBased()) throw new Error('Feed-Channel nicht verfuegbar/Text-Channel');
    const textChannel = channel as GuildTextBasedChannel;
    if (textChannel.guildId !== config.guildId) throw new Error('Feed-Channel gehoert nicht zur Guild');

    const stillActive = await prisma.gameplayFeedConfig.findFirst({
      where: {
        id: config.id,
        guildId: config.guildId,
        nitradoConnId: config.nitradoConnId,
        isActive: true,
      },
      select: { id: true },
    });
    if (!stillActive) {
      await prisma.gameplayFeedDelivery.updateMany({
        where: { id: delivery.id, status: GameplayDeliveryStatus.SENDING },
        data: { status: GameplayDeliveryStatus.PENDING, leaseUntil: null },
      });
      return;
    }

    const view = deriveGameplayFeedView(event, {
      showActorCoords: config.showActorCoords,
      showTargetCoords: config.showTargetCoords,
      showTool: config.showTool,
      showDistance: config.showDistance,
    });
    if (!view) throw new Error(`Nicht unterstuetzter Gameplay-Eventtyp: ${event.eventType}`);

    const message = await textChannel.send({
      embeds: [buildGameplayFeedEmbed(view, config.embedColor, serverAlias)],
      allowedMentions: { parse: [] },
      nonce: eventNonce(event.id),
      enforceNonce: true,
    });
    await markSent(config, claimedDelivery, event, message.id);
    await prisma.gameplayFeedConfig.updateMany({
      where: { id: config.id, guildId: config.guildId, nitradoConnId: config.nitradoConnId },
      data: { nextDeliveryAt: new Date(Date.now() + DELIVERY_SPACING_MS) },
    });

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

async function currentPlayerList(config: GameplayFeedConfig): Promise<PlayerListEntry[]> {
  // Die Online List ist ein Live-Roster und darf deshalb niemals historische
  // PlayerSession.status=OPEN-Zeilen als Wahrheit verwenden. Ein Reconnect kann
  // absichtlich eine alte Session OPEN lassen; fuer "online" entscheidet nur
  // das neueste CONNECT/DISCONNECT der aktuell laufenden ADM-Datei.
  const binding = await prisma.nitradoAdmBindingState.findUnique({
    where: {
      guildId_nitradoConnId: {
        guildId: config.guildId,
        nitradoConnId: config.nitradoConnId,
      },
    },
    select: { bindingVersion: true },
  });
  const namespacePrefix = admBindingFileIdentityPrefix(binding?.bindingVersion ?? 0);
  const latestCursor = await prisma.admSourceCursor.findFirst({
    where: {
      guildId: config.guildId,
      nitradoConnId: config.nitradoConnId,
      ...(namespacePrefix ? { fileIdentity: { startsWith: namespacePrefix } } : {}),
    },
    orderBy: [{ lastModifiedAt: 'desc' }, { fileName: 'desc' }],
    select: { fileIdentity: true },
  });
  if (!latestCursor) return [];

  const presenceEvents = await prisma.admEvent.findMany({
    where: {
      guildId: config.guildId,
      nitradoConnId: config.nitradoConnId,
      sourceFile: latestCursor.fileIdentity,
      eventType: { in: [AdmEventType.PLAYER_CONNECTED, AdmEventType.PLAYER_DISCONNECTED] },
      actorGameId: { not: null },
    },
    select: {
      id: true,
      eventType: true,
      actorGameId: true,
      actorName: true,
      sourceByteStart: true,
    },
    orderBy: [{ sourceByteStart: 'desc' }, { id: 'desc' }],
  }) as PlayerPresenceEvent[];

  const online = resolveOnlinePresence(presenceEvents);
  if (online.length === 0) return [];

  const positions = await prisma.admEvent.findMany({
    where: {
      guildId: config.guildId,
      nitradoConnId: config.nitradoConnId,
      sourceFile: latestCursor.fileIdentity,
      eventType: AdmEventType.PLAYER_POSITION,
      actorGameId: { in: online.map(player => player.gameId) },
    },
    select: {
      id: true,
      actorGameId: true,
      actorPosition: true,
      sourceByteStart: true,
    },
    orderBy: [{ sourceByteStart: 'desc' }, { id: 'desc' }],
  }) as PlayerPositionEvent[];

  return attachCurrentPositions(online, positions);
}

async function processPlayerListConfig(config: GameplayFeedConfig, serverAlias: string): Promise<void> {
  try {
    const entries = await currentPlayerList(config);
    const stateHash = playerListStateHash(entries, config.showActorCoords);
    const now = new Date();
    const intervalMinutes = config.playerListIntervalMinutes ?? 0;
    const intervalMs = intervalMinutes > 0 ? intervalMinutes * 60_000 : 0;
    const periodicDue = intervalMs > 0
      && (!config.nextPlayerListPostAt || config.nextPlayerListPostAt.getTime() <= now.getTime());
    const stateChanged = config.lastStateHash !== stateHash || !config.lastMessageId;

    if (!stateChanged && !periodicDue) {
      await prisma.gameplayFeedConfig.updateMany({
        where: { id: config.id, guildId: config.guildId, nitradoConnId: config.nitradoConnId, isActive: true },
        data: { lastPolledAt: now, lastPlayerCount: entries.length },
      });
      return;
    }

    const client = tryGetDashboardClient();
    if (!client) throw new Error('Discord-Client nicht verfuegbar');
    const channel = await client.channels.fetch(config.channelId).catch(() => null);
    if (!channel || !channel.isTextBased() || channel.isDMBased()) throw new Error('Online-List-Channel nicht verfuegbar/Text-Channel');
    const textChannel = channel as GuildTextBasedChannel;
    if (textChannel.guildId !== config.guildId) throw new Error('Online-List-Channel gehoert nicht zur Guild');
    const embeds = buildPlayerListEmbeds({
      serverAlias,
      entries,
      showCoordinates: config.showActorCoords,
      embedColor: config.embedColor,
      generatedAt: now,
    });

    // The dashboard can disable the feed while the ADM snapshot is being read.
    // Re-check immediately before the only external side effect (Discord).
    const stillActive = await prisma.gameplayFeedConfig.count({
      where: {
        id: config.id,
        guildId: config.guildId,
        nitradoConnId: config.nitradoConnId,
        isActive: true,
      },
    });
    if (stillActive !== 1) return;

    // Ein faelliges Intervall erzeugt bewusst einen neuen Discord-Post. Reine
    // Zustandsaenderungen aktualisieren dagegen weiterhin die zuletzt gesendete
    // Online List, damit Join/Leave/Positionsaenderungen nicht den Kanal fluten.
    let messageId = periodicDue ? null : config.lastMessageId;
    if (messageId) {
      const message = await textChannel.messages.fetch(messageId).catch(() => null);
      if (message) await message.edit({ embeds, allowedMentions: { parse: [] } });
      else messageId = null;
    }
    if (!messageId) {
      const postKey = periodicDue && intervalMs > 0
        ? `interval:${Math.floor(now.getTime() / intervalMs)}`
        : 'state';
      const message = await textChannel.send({
        embeds,
        allowedMentions: { parse: [] },
        nonce: playerListNonce(config.id, stateHash, postKey),
        enforceNonce: true,
      });
      messageId = message.id;
    }

    const nextPlayerListPostAt = intervalMs > 0
      ? (periodicDue ? new Date(now.getTime() + intervalMs) : config.nextPlayerListPostAt)
      : null;

    await prisma.gameplayFeedConfig.updateMany({
      where: { id: config.id, guildId: config.guildId, nitradoConnId: config.nitradoConnId, isActive: true },
      data: {
        lastMessageId: messageId,
        lastStateHash: stateHash,
        lastPlayerCount: entries.length,
        lastPlayerListAt: now,
        nextPlayerListPostAt,
        lastEventAt: now,
        lastPolledAt: now,
        lastErrorMsg: null,
      },
    });
  } catch (error) {
    const message = safeError(error);
    await prisma.gameplayFeedConfig.updateMany({
      where: { id: config.id, guildId: config.guildId, nitradoConnId: config.nitradoConnId },
      data: { lastPolledAt: new Date(), lastErrorMsg: message },
    });
  }
}

/**
 * Reserviert einen Discord-Ausgabe-Slot nicht nur pro Config, sondern pro
 * Guild+Channel. Die kanonisch erste Config-Zeile des Channels dient als
 * transaktionaler FOR-UPDATE-Mutex, damit auch mehrere Bot-Prozesse nicht
 * gleichzeitig je einen Feedpost in denselben Channel schicken koennen.
 */
async function reserveChannelDeliverySlot(config: GameplayFeedConfig): Promise<boolean> {
  const now = new Date();
  const next = new Date(now.getTime() + DELIVERY_SPACING_MS);
  return prisma.$transaction(async tx => {
    const lock = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id"
        FROM "GameplayFeedConfig"
       WHERE "guildId"=${config.guildId}
         AND "channelId"=${config.channelId}
         AND "kind" <> 'PLAYER_LIST'::"GameplayFeedKind"
       ORDER BY "id" ASC
       LIMIT 1
       FOR UPDATE
    `);
    if (!lock[0]) return false;

    const blocked = await tx.gameplayFeedConfig.findFirst({
      where: {
        guildId: config.guildId,
        channelId: config.channelId,
        isActive: true,
        kind: { not: GameplayFeedKind.PLAYER_LIST },
        nextDeliveryAt: { gt: now },
      },
      select: { id: true },
    });
    if (blocked) return false;

    const reserved = await tx.gameplayFeedConfig.updateMany({
      where: {
        id: config.id,
        guildId: config.guildId,
        nitradoConnId: config.nitradoConnId,
        channelId: config.channelId,
        isActive: true,
        kind: { not: GameplayFeedKind.PLAYER_LIST },
      },
      data: { nextDeliveryAt: next },
    });
    return reserved.count === 1;
  });
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

  if (config.kind === GameplayFeedKind.PLAYER_LIST) {
    await processPlayerListConfig(config, connection.alias);
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
    if (due.length === 0 || !(await reserveChannelDeliverySlot(config))) {
      await prisma.gameplayFeedConfig.updateMany({
        where: { id: config.id, guildId: config.guildId, nitradoConnId: config.nitradoConnId },
        data: { lastPolledAt: new Date() },
      });
      return;
    }
    for (const delivery of due) await deliverOne(config, delivery, connection.alias);
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
    // configId+guildId+nitradoConnId gebunden. Der Discord-Nonce verhindert,
    // dass ein Retry nach einem erfolgreichen Send einen sichtbaren Duplikatpost erzeugt.
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
        lastError: 'Delivery lease expired; retry with stable Discord nonce required',
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
