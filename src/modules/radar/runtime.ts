import { createHash } from 'node:crypto';
import { EmbedBuilder, type ColorResolvable, type GuildTextBasedChannel } from 'discord.js';
import { RadarDeliveryStatus, type RadarConfig, type RadarZoneEvent } from '@prisma/client';
import prisma from '../../database/prisma';
import { tryGetDashboardClient } from '../../dashboard/clientRegistry';
import { emitRadarEvent } from '../../dashboard/socket/emitter';
import { logger } from '../../utils/logger';
import { safeEmbedField } from '../../utils/embedSanitize';
import { dayzIzurviveUrl, type RadarMap } from '../../shared/radarCoordinates';
import { radarFunctionsForEvent, type RadarAdmEvent } from './catalog';
import { boundsContainPosition, containsPosition, type RadarGeometry, type RadarPoint } from './geometry';

const POLL_INTERVAL_MS = 15_000;
const SCAN_BATCH = 200;
const MAX_SCAN_BATCHES_PER_TICK = 5;
const DELIVERY_BATCH = 10;
const LEASE_MS = 60_000;
const MAX_DELIVERY_ATTEMPTS = 8;

let timer: NodeJS.Timeout | null = null;
let running = false;

type ZoneRow = {
  id: string;
  guildId: string;
  nitradoConnId: string;
  channelId: string;
  rolePingEnabled: boolean;
  roleIds: string[];
  shape: 'CIRCLE' | 'POLYGON';
  centerX: unknown;
  centerY: unknown;
  radiusMeters: unknown;
  minX: unknown;
  minY: unknown;
  maxX: unknown;
  maxY: unknown;
  points: Array<{ x: unknown; y: unknown }>;
  functions: Array<{ functionKey: string }>;
  allowlist: Array<{ gameId: string }>;
};

type RadarScannedAdmEvent = RadarAdmEvent & { createdAt: Date };

function toNumber(value: unknown): number {
  return Number(value);
}

function retryDelayMs(attempt: number): number {
  return Math.min(15 * 60_000, 15_000 * Math.pow(2, Math.max(0, attempt - 1)));
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]').slice(0, 1000);
}

function radarEventNonce(eventId: string): string {
  return createHash('sha256').update(`radar-zone-event\u0000${eventId}`).digest('hex').slice(0, 25);
}

function admTime(value: Date | null): string {
  if (!value || Number.isNaN(value.getTime())) return 'Nicht eindeutig aufloesbar';
  const parts = new Intl.DateTimeFormat('de-DE', {
    timeZone: 'UTC', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find(item => item.type === type)?.value ?? '';
  return `${part('day')}.${part('month')}.${part('year')} · ${part('hour')}:${part('minute')}:${part('second')} UTC`;
}

function coordinateField(map: RadarMap, event: RadarZoneEvent): string {
  const x = Number(event.x).toFixed(1);
  const y = Number(event.y).toFixed(1);
  const label = `${x} / ${y}`;
  const url = dayzIzurviveUrl(map, { x: Number(event.x), y: Number(event.y) });
  return url ? `[${label}](${url})` : label;
}

export function buildRadarEmbed(event: RadarZoneEvent, zone: { name: string; map: RadarMap; embedColor: string }): EmbedBuilder {
  const embed = new EmbedBuilder().setColor(zone.embedColor as ColorResolvable).setTitle(safeEmbedField(zone.name, 256));
  const username = safeEmbedField(event.actorName ?? 'Unaufgeloest', 256);
  const coordinates = coordinateField(zone.map, event);
  if (event.functionKey === 'PLAYER_DETECTION') {
    return embed.addFields(
      { name: 'Username', value: username, inline: false },
      { name: 'Koordinaten', value: coordinates, inline: false },
      { name: 'Erkannt durch ADM', value: admTime(event.admOccurredAt), inline: false },
    );
  }

  embed.addFields(
    { name: 'Username', value: username, inline: false },
    { name: 'Aktion', value: safeEmbedField(event.functionKey, 128), inline: false },
    { name: 'Koordinaten', value: coordinates, inline: false },
    { name: 'ADM-Zeit', value: admTime(event.admOccurredAt), inline: false },
  );
  if (event.objectType) embed.addFields({ name: 'Objekt', value: safeEmbedField(event.objectType, 256), inline: false });
  if (event.toolOrWeapon) embed.addFields({ name: 'Werkzeug / Waffe', value: safeEmbedField(event.toolOrWeapon, 256), inline: false });
  if (event.targetName) embed.addFields({ name: 'Betroffener Spieler', value: safeEmbedField(event.targetName, 256), inline: false });
  if (event.distanceMeters !== null) embed.addFields({ name: 'Distanz', value: `${Number(event.distanceMeters).toFixed(1)} m`, inline: false });
  return embed;
}

async function markDeliveryFailure(event: RadarZoneEvent, error: unknown): Promise<void> {
  const attempts = event.attempts + 1;
  await prisma.radarZoneEvent.updateMany({
    where: { id: event.id, guildId: event.guildId, nitradoConnId: event.nitradoConnId, status: RadarDeliveryStatus.SENDING },
    data: {
      status: attempts >= MAX_DELIVERY_ATTEMPTS ? RadarDeliveryStatus.FAILED : RadarDeliveryStatus.RETRY,
      attempts,
      nextAttemptAt: new Date(Date.now() + retryDelayMs(attempts)),
      leaseUntil: null,
      lastError: safeError(error),
    },
  });
}

async function deliverRadarEvent(event: RadarZoneEvent): Promise<void> {
  const claimed = await prisma.radarZoneEvent.updateMany({
    where: { id: event.id, guildId: event.guildId, nitradoConnId: event.nitradoConnId, status: { in: [RadarDeliveryStatus.PENDING, RadarDeliveryStatus.RETRY] }, nextAttemptAt: { lte: new Date() } },
    data: { status: RadarDeliveryStatus.SENDING, leaseUntil: new Date(Date.now() + LEASE_MS) },
  });
  if (claimed.count !== 1) return;
  try {
    const zone = await prisma.radarZone.findFirst({
      where: { id: event.zoneId, guildId: event.guildId, nitradoConnId: event.nitradoConnId, isActive: true },
      select: { name: true, map: true, channelId: true, rolePingEnabled: true, roleIds: true, embedColor: true },
    });
    if (!zone) {
      await prisma.radarZoneEvent.updateMany({
        where: { id: event.id, status: RadarDeliveryStatus.SENDING },
        data: { status: RadarDeliveryStatus.FAILED, leaseUntil: null, lastError: 'Zone is no longer active' },
      });
      return;
    }
    const client = tryGetDashboardClient();
    if (!client) throw new Error('Discord-Client nicht verfuegbar');
    const channel = await client.channels.fetch(zone.channelId).catch(() => null);
    if (!channel || !channel.isTextBased() || channel.isDMBased()) throw new Error('Radar-Channel nicht verfuegbar/Text-Channel');
    const textChannel = channel as GuildTextBasedChannel;
    if (textChannel.guildId !== event.guildId) throw new Error('Radar-Channel gehoert nicht zur Guild');
    const roleIds = zone.rolePingEnabled ? [...new Set(zone.roleIds)] : [];
    const message = await textChannel.send({
      content: roleIds.map(roleId => `<@&${roleId}>`).join(' ') || undefined,
      embeds: [buildRadarEmbed(event, zone)],
      allowedMentions: { parse: [], roles: roleIds },
      nonce: radarEventNonce(event.id),
      enforceNonce: true,
    });
    await prisma.radarZoneEvent.updateMany({
      where: { id: event.id, guildId: event.guildId, nitradoConnId: event.nitradoConnId, status: RadarDeliveryStatus.SENDING },
      data: { status: RadarDeliveryStatus.SENT, messageId: message.id, sentAt: new Date(), leaseUntil: null, lastError: null },
    });
  } catch (error) {
    await markDeliveryFailure(event, error);
  }
}

async function deliverPendingRadarEvents(config: RadarConfig): Promise<void> {
  const events = await prisma.radarZoneEvent.findMany({
    where: { guildId: config.guildId, nitradoConnId: config.nitradoConnId, status: { in: [RadarDeliveryStatus.PENDING, RadarDeliveryStatus.RETRY] }, nextAttemptAt: { lte: new Date() } },
    orderBy: [{ nextAttemptAt: 'asc' }, { createdAt: 'asc' }],
    take: DELIVERY_BATCH,
  });
  for (const event of events) await deliverRadarEvent(event);
}

function geometryFor(zone: ZoneRow): RadarGeometry | null {
  const bounds = { minX: toNumber(zone.minX), minY: toNumber(zone.minY), maxX: toNumber(zone.maxX), maxY: toNumber(zone.maxY) };
  if (Object.values(bounds).some(value => !Number.isFinite(value))) return null;
  if (zone.shape === 'CIRCLE') {
    const centerX = toNumber(zone.centerX);
    const centerY = toNumber(zone.centerY);
    const radiusMeters = toNumber(zone.radiusMeters);
    if (![centerX, centerY, radiusMeters].every(Number.isFinite) || radiusMeters <= 0) return null;
    return { shape: 'CIRCLE', centerX, centerY, radiusMeters, ...bounds };
  }
  const points: RadarPoint[] = zone.points.map(point => ({ x: toNumber(point.x), y: toNumber(point.y) }));
  return points.length >= 3 && points.every(point => Number.isFinite(point.x) && Number.isFinite(point.y))
    ? { shape: 'POLYGON', points, ...bounds }
    : null;
}

async function emitPersistedRadarEvent(radarEventId: string): Promise<void> {
  const event = await prisma.radarZoneEvent.findUnique({
    where: { id: radarEventId },
    select: { id: true, zoneId: true, guildId: true, nitradoConnId: true, functionKey: true, actorName: true, x: true, y: true, altitude: true, admOccurredAt: true },
  });
  if (!event) return;
  emitRadarEvent({
    guildId: event.guildId,
    nitradoConnId: event.nitradoConnId,
    zoneId: event.zoneId,
    radarEventId: event.id,
    functionKey: event.functionKey,
    actorName: event.actorName,
    x: Number(event.x),
    y: Number(event.y),
    altitude: event.altitude === null ? null : Number(event.altitude),
    admOccurredAt: event.admOccurredAt?.toISOString() ?? null,
  });
}

async function evaluateEvent(config: RadarConfig, event: RadarAdmEvent): Promise<void> {
  for (const definition of radarFunctionsForEvent(event.eventType)) {
    const candidates = definition.selectPositions(event);
    if (candidates.length === 0) continue;
    const zones = await prisma.radarZone.findMany({
      where: {
        configId: config.id,
        guildId: config.guildId,
        nitradoConnId: config.nitradoConnId,
        map: config.activeMap,
        isActive: true,
        functions: { some: { functionKey: definition.key } },
      },
      include: { points: { orderBy: { position: 'asc' } }, functions: true, allowlist: true },
    }) as unknown as ZoneRow[];

    for (const candidate of candidates) {
      for (const zone of zones) {
        if (candidate.gameId && zone.allowlist.some(entry => entry.gameId === candidate.gameId)) continue;
        const geometry = geometryFor(zone);
        if (!geometry || !boundsContainPosition(geometry, candidate.position) || !containsPosition(geometry, candidate.position)) continue;
        try {
          const created = await prisma.radarZoneEvent.create({
            data: {
              zoneId: zone.id,
              admEventId: event.id,
              functionKey: definition.key,
              guildId: config.guildId,
              nitradoConnId: config.nitradoConnId,
              channelId: zone.channelId,
              admEventType: event.eventType,
              actorGameId: candidate.gameId,
              actorName: candidate.playerName,
              targetGameId: event.targetGameId,
              targetName: event.targetName,
              objectType: event.objectType,
              toolOrWeapon: event.toolOrWeapon,
              distanceMeters: event.distanceMeters,
              x: candidate.position.x,
              y: candidate.position.y,
              altitude: candidate.position.altitude,
              admOccurredAt: event.occurredAt,
              status: RadarDeliveryStatus.PENDING,
            },
            select: { id: true },
          });
          await emitPersistedRadarEvent(created.id);
        } catch (error) {
          if ((error as { code?: string }).code !== 'P2002') throw error;
        }
      }
    }
  }
}

async function processConfig(config: RadarConfig): Promise<void> {
  let cursorCreatedAt = config.cursorCreatedAt;
  let cursorEventId = config.cursorEventId;
  for (let batch = 0; batch < MAX_SCAN_BATCHES_PER_TICK; batch += 1) {
    const events = await prisma.admEvent.findMany({
      where: {
        guildId: config.guildId,
        nitradoConnId: config.nitradoConnId,
        OR: [{ createdAt: { gt: cursorCreatedAt } }, { createdAt: cursorCreatedAt, id: { gt: cursorEventId } }],
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: SCAN_BATCH,
      select: { id: true, eventType: true, occurredAt: true, createdAt: true, actorGameId: true, actorName: true, targetGameId: true, targetName: true, objectType: true, toolOrWeapon: true, distanceMeters: true, actorPosition: true, targetPosition: true },
    }) as RadarScannedAdmEvent[];
    if (events.length === 0) break;
    for (const event of events) await evaluateEvent(config, event);
    const last = events[events.length - 1];
    const nextCursorCreatedAt = last.createdAt;
    const nextCursorEventId = last.id;
    const advanced = await prisma.radarConfig.updateMany({
      where: { id: config.id, guildId: config.guildId, nitradoConnId: config.nitradoConnId, cursorCreatedAt, cursorEventId },
      data: { cursorCreatedAt: nextCursorCreatedAt, cursorEventId: nextCursorEventId },
    });
    if (advanced.count !== 1) return;
    cursorCreatedAt = nextCursorCreatedAt;
    cursorEventId = nextCursorEventId;
    if (events.length < SCAN_BATCH) break;
  }
  await deliverPendingRadarEvents(config);
}

export async function runRadarRuntimeOnce(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const expiredLease = { status: RadarDeliveryStatus.SENDING, leaseUntil: { lt: new Date() } };
    await prisma.radarZoneEvent.updateMany({
      where: { ...expiredLease, attempts: { gte: MAX_DELIVERY_ATTEMPTS - 1 } },
      data: { status: RadarDeliveryStatus.FAILED, attempts: { increment: 1 }, leaseUntil: null, lastError: 'Delivery lease expired after maximum retry attempts' },
    });
    await prisma.radarZoneEvent.updateMany({
      where: { ...expiredLease, attempts: { lt: MAX_DELIVERY_ATTEMPTS - 1 } },
      data: { status: RadarDeliveryStatus.RETRY, attempts: { increment: 1 }, nextAttemptAt: new Date(), leaseUntil: null, lastError: 'Delivery lease expired; retry with stable Discord nonce required' },
    });
    const configs = await prisma.radarConfig.findMany({ orderBy: { createdAt: 'asc' } });
    for (const config of configs) await processConfig(config);
  } catch (error) {
    logger.error('Radar-Worker Fehler:', error as Error);
  } finally {
    running = false;
  }
}

export function startRadarRuntime(): void {
  if (timer) return;
  timer = setInterval(() => { void runRadarRuntimeOnce(); }, POLL_INTERVAL_MS);
  timer.unref?.();
  void runRadarRuntimeOnce();
}

export function stopRadarRuntime(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}