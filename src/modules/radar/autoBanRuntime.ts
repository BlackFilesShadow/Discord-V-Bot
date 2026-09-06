import {
  RadarAutoBanStatus,
  type Prisma,
  type RadarMap,
} from '@prisma/client';
import prisma from '../../database/prisma';
import { config } from '../../config';
import { logAudit, logger } from '../../utils/logger';
import { isValidBattleyeGuid } from '../../utils/guid';
import { addBan, isBanActive, type BanClient } from '../bans/banRegistry';
import { hashBanIdentifier } from '../bans/banTarget';
import { enqueueServerBanAdd, type BanOutboxClient } from '../bans/banOutbox';
import { admBindingFileIdentityPrefix } from '../nitrado/adm/bindingState';
import { radarFunctionByKey, type RadarAdmEvent } from './catalog';
import {
  containsPositionWithMargin,
  createCircleGeometry,
  createPolygonGeometry,
  type RadarGeometry,
  type RadarPoint,
} from './geometry';
import { lockRadarScope } from './lock';

const POLL_INTERVAL_MS = 15_000;
const LEASE_MS = 60_000;
const MAX_ATTEMPTS = 8;
const BATCH_SIZE = 10;
const RETRY_BASE_MS = 15_000;
const AUTO_BAN_SAFETY_MARGIN_METERS = 10;
const MAX_FUTURE_ADM_SKEW_MS = 5 * 60_000;
const DISCORD_SNOWFLAKE_RE = /^\d{17,20}$/;
const POSITION_EPSILON_METERS = 0.05;

let timer: NodeJS.Timeout | null = null;
let running = false;

type JsonValue = Prisma.JsonValue;

type ZoneForAutoBan = {
  id: string;
  configId: string;
  guildId: string;
  nitradoConnId: string;
  name: string;
  map: RadarMap;
  shape: 'CIRCLE' | 'POLYGON';
  isActive: boolean;
  autoBanEnabled: boolean;
  autoBanEnabledAt: Date | null;
  version: number;
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

type EventForAutoBan = {
  id: string;
  zoneId: string;
  admEventId: string;
  functionKey: string;
  guildId: string;
  nitradoConnId: string;
  admEventType: string;
  actorGameId: string | null;
  actorName: string | null;
  x: unknown;
  y: unknown;
  admOccurredAt: Date | null;
  zoneVersionSnapshot: number;
  zoneMapSnapshot: RadarMap | null;
  zoneGeometrySnapshot: JsonValue | null;
  zoneFunctionsSnapshot: JsonValue | null;
  zoneAllowlistSnapshot: JsonValue | null;
  autoBanEnabledSnapshot: boolean;
  autoBanEnabledAtSnapshot: Date | null;
  autoBanAuthorizedBy: string | null;
  autoBanStatus: RadarAutoBanStatus;
  autoBanAttempts: number;
};

type ValidationResult =
  | { ok: true; identifier: string; reason: string; actorName: string | null }
  | { ok: false; code: string };

function retryDelayMs(attempt: number): number {
  return Math.min(15 * 60_000, RETRY_BASE_MS * Math.pow(2, Math.max(0, attempt - 1)));
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .slice(0, 1000);
}

function asRecord(value: JsonValue | null): Record<string, JsonValue> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, JsonValue> : null;
}

function asNumber(value: unknown): number {
  return Number(value);
}

function snapshotGeometry(value: JsonValue | null): RadarGeometry | null {
  const raw = asRecord(value);
  if (!raw) return null;
  if (raw.shape === 'CIRCLE') {
    return createCircleGeometry(asNumber(raw.centerX), asNumber(raw.centerY), asNumber(raw.radiusMeters));
  }
  if (raw.shape !== 'POLYGON' || !Array.isArray(raw.points)) return null;
  const points: RadarPoint[] = raw.points.flatMap(item => {
    const point = item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, JsonValue> : null;
    if (!point) return [];
    const x = asNumber(point.x);
    const y = asNumber(point.y);
    return Number.isFinite(x) && Number.isFinite(y) ? [{ x, y }] : [];
  });
  return createPolygonGeometry(points);
}

function currentGeometry(zone: ZoneForAutoBan): RadarGeometry | null {
  if (zone.shape === 'CIRCLE') {
    return createCircleGeometry(asNumber(zone.centerX), asNumber(zone.centerY), asNumber(zone.radiusMeters));
  }
  const points = zone.points.map(point => ({ x: asNumber(point.x), y: asNumber(point.y) }));
  return createPolygonGeometry(points);
}

function near(a: number, b: number, epsilon = 0.001): boolean {
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= epsilon;
}

function sameGeometry(a: RadarGeometry, b: RadarGeometry): boolean {
  if (a.shape !== b.shape) return false;
  if (a.shape === 'CIRCLE' && b.shape === 'CIRCLE') {
    return near(a.centerX, b.centerX) && near(a.centerY, b.centerY) && near(a.radiusMeters, b.radiusMeters);
  }
  if (a.shape !== 'POLYGON' || b.shape !== 'POLYGON' || a.points.length !== b.points.length) return false;
  return a.points.every((point, index) => near(point.x, b.points[index].x) && near(point.y, b.points[index].y));
}

function stringArray(value: JsonValue | null): string[] | null {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) return null;
  return value as string[];
}

function sameInstant(a: Date | null, b: Date | null): boolean {
  if (!a || !b) return a === b;
  return a.getTime() === b.getTime();
}

function sourceBelongsToCurrentBinding(sourceFile: string, bindingVersion: number): boolean {
  const prefix = admBindingFileIdentityPrefix(bindingVersion);
  return prefix ? sourceFile.startsWith(prefix) : !sourceFile.startsWith('adm-binding:');
}

function matchingCandidate(event: EventForAutoBan, admEvent: RadarAdmEvent): boolean {
  const definition = radarFunctionByKey(event.functionKey);
  if (!definition || !definition.sourceEvents.includes(admEvent.eventType)) return false;
  const eventX = asNumber(event.x);
  const eventY = asNumber(event.y);
  const matches = definition.selectPositions(admEvent).filter(candidate =>
    candidate.gameId === event.actorGameId
      && near(candidate.position.x, eventX, POSITION_EPSILON_METERS)
      && near(candidate.position.y, eventY, POSITION_EPSILON_METERS),
  );
  return matches.length === 1;
}

async function validateInsideTransaction(
  tx: Prisma.TransactionClient,
  event: EventForAutoBan,
  now: Date,
): Promise<ValidationResult> {
  if (!event.autoBanEnabledSnapshot || !event.autoBanEnabledAtSnapshot) return { ok: false, code: 'AUTOBAN_NOT_ARMED_IN_SNAPSHOT' };
  if (!event.autoBanAuthorizedBy || !DISCORD_SNOWFLAKE_RE.test(event.autoBanAuthorizedBy)) return { ok: false, code: 'AUTOBAN_AUTHORIZER_INVALID' };
  if (!isValidBattleyeGuid(event.actorGameId)) return { ok: false, code: 'ACTOR_GUID_INVALID_OR_MISSING' };
  if (!event.admOccurredAt) return { ok: false, code: 'ADM_OCCURRED_AT_MISSING' };
  if (event.admOccurredAt.getTime() > now.getTime() + MAX_FUTURE_ADM_SKEW_MS) return { ok: false, code: 'ADM_TIME_IN_FUTURE' };

  const zone = await tx.radarZone.findFirst({
    where: { id: event.zoneId, guildId: event.guildId, nitradoConnId: event.nitradoConnId },
    include: { points: { orderBy: { position: 'asc' } }, functions: true, allowlist: true },
  }) as unknown as ZoneForAutoBan | null;
  if (!zone) return { ok: false, code: 'ZONE_NOT_FOUND' };
  if (!zone.isActive || !zone.autoBanEnabled || !zone.autoBanEnabledAt) return { ok: false, code: 'ZONE_OR_AUTOBAN_DISABLED' };
  if (zone.version !== event.zoneVersionSnapshot) return { ok: false, code: 'ZONE_VERSION_CHANGED' };
  if (zone.map !== event.zoneMapSnapshot) return { ok: false, code: 'ZONE_MAP_CHANGED' };
  if (!sameInstant(zone.autoBanEnabledAt, event.autoBanEnabledAtSnapshot)) return { ok: false, code: 'AUTOBAN_ARM_GENERATION_CHANGED' };

  const radarConfig = await tx.radarConfig.findUnique({
    where: { guildId_nitradoConnId: { guildId: event.guildId, nitradoConnId: event.nitradoConnId } },
    select: { activeMap: true },
  });
  if (!radarConfig || radarConfig.activeMap !== zone.map) return { ok: false, code: 'ZONE_MAP_NOT_ACTIVE' };

  const snapshotFunctions = stringArray(event.zoneFunctionsSnapshot);
  if (!snapshotFunctions || !snapshotFunctions.includes(event.functionKey)) return { ok: false, code: 'FUNCTION_NOT_ENABLED_IN_SNAPSHOT' };
  if (!zone.functions.some(entry => entry.functionKey === event.functionKey)) return { ok: false, code: 'FUNCTION_DISABLED_CURRENTLY' };

  const snapshotAllowlist = stringArray(event.zoneAllowlistSnapshot);
  if (!snapshotAllowlist) return { ok: false, code: 'ALLOWLIST_SNAPSHOT_INVALID' };
  if (snapshotAllowlist.includes(event.actorGameId) || zone.allowlist.some(entry => entry.gameId === event.actorGameId)) {
    return { ok: false, code: 'ACTOR_ALLOWLISTED' };
  }

  const snapGeometry = snapshotGeometry(event.zoneGeometrySnapshot);
  const liveGeometry = currentGeometry(zone);
  if (!snapGeometry || !liveGeometry || !sameGeometry(snapGeometry, liveGeometry)) return { ok: false, code: 'GEOMETRY_CHANGED_OR_INVALID' };
  const eventPosition = { x: asNumber(event.x), y: asNumber(event.y) };
  if (!containsPositionWithMargin(snapGeometry, eventPosition, AUTO_BAN_SAFETY_MARGIN_METERS)) {
    return { ok: false, code: 'BOUNDARY_SAFETY_MARGIN' };
  }

  const adm = await tx.admEvent.findFirst({
    where: { id: event.admEventId, guildId: event.guildId, nitradoConnId: event.nitradoConnId },
    select: {
      id: true,
      sourceFile: true,
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
  });
  if (!adm) return { ok: false, code: 'ADM_EVENT_NOT_FOUND_IN_SCOPE' };
  if (adm.eventType !== event.admEventType) return { ok: false, code: 'ADM_EVENT_TYPE_CHANGED' };
  if (!sameInstant(adm.occurredAt, event.admOccurredAt)) return { ok: false, code: 'ADM_EVENT_TIME_MISMATCH' };
  if (adm.createdAt.getTime() <= event.autoBanEnabledAtSnapshot.getTime()) return { ok: false, code: 'ADM_EVENT_PREDATES_AUTOBAN_ARM' };
  if (adm.actorGameId !== event.actorGameId) return { ok: false, code: 'ADM_ACTOR_GUID_MISMATCH' };

  const binding = await tx.nitradoAdmBindingState.findUnique({
    where: { guildId_nitradoConnId: { guildId: event.guildId, nitradoConnId: event.nitradoConnId } },
    select: { bindingVersion: true, currentServiceId: true },
  });
  if (!binding?.currentServiceId || !sourceBelongsToCurrentBinding(adm.sourceFile, binding.bindingVersion)) {
    return { ok: false, code: 'ADM_BINDING_GENERATION_MISMATCH' };
  }

  const radarAdm: RadarAdmEvent = {
    id: adm.id,
    eventType: adm.eventType,
    occurredAt: adm.occurredAt,
    actorGameId: adm.actorGameId,
    actorName: adm.actorName,
    targetGameId: adm.targetGameId,
    targetName: adm.targetName,
    objectType: adm.objectType,
    toolOrWeapon: adm.toolOrWeapon,
    distanceMeters: adm.distanceMeters,
    actorPosition: adm.actorPosition,
    targetPosition: adm.targetPosition,
  };
  if (!matchingCandidate(event, radarAdm)) return { ok: false, code: 'EVENT_POSITION_OR_FUNCTION_MISMATCH' };

  const definition = radarFunctionByKey(event.functionKey);
  if (!definition) return { ok: false, code: 'FUNCTION_DEFINITION_MISSING' };
  return {
    ok: true,
    identifier: event.actorGameId,
    actorName: event.actorName,
    reason: `Radar Auto-Ban: ${zone.name} / ${definition.label}`.slice(0, 300),
  };
}

async function markSkipped(tx: Prisma.TransactionClient, eventId: string, code: string, now: Date): Promise<void> {
  await tx.radarZoneEvent.updateMany({
    where: { id: eventId, autoBanStatus: RadarAutoBanStatus.PROCESSING },
    data: {
      autoBanStatus: RadarAutoBanStatus.SKIPPED,
      autoBanProcessedAt: now,
      autoBanLeaseUntil: null,
      autoBanLastError: code,
    },
  });
}

async function processAutoBanEvent(eventId: string, attempts: number): Promise<void> {
  const now = new Date();
  const claimed = await prisma.radarZoneEvent.updateMany({
    where: {
      id: eventId,
      autoBanStatus: { in: [RadarAutoBanStatus.PENDING, RadarAutoBanStatus.RETRY] },
      autoBanNextAttemptAt: { lte: now },
    },
    data: { autoBanStatus: RadarAutoBanStatus.PROCESSING, autoBanLeaseUntil: new Date(now.getTime() + LEASE_MS) },
  });
  if (claimed.count !== 1) return;

  try {
    const outcome = await prisma.$transaction(async tx => {
      const event = await tx.radarZoneEvent.findUnique({ where: { id: eventId } }) as unknown as EventForAutoBan | null;
      if (!event || event.autoBanStatus !== RadarAutoBanStatus.PROCESSING) return { kind: 'NOOP' as const };

      await lockRadarScope(tx, event.guildId, event.nitradoConnId);
      const validation = await validateInsideTransaction(tx, event, now);
      if (!validation.ok) {
        await markSkipped(tx, event.id, validation.code, now);
        return { kind: 'SKIPPED' as const, code: validation.code, event };
      }

      const scope = { guildId: event.guildId, nitradoConnId: event.nitradoConnId };
      const identityHash = hashBanIdentifier(validation.identifier, config.security.encryptionKey);
      const existing = await tx.serverBanEntry.findUnique({
        where: { guildId_nitradoConnId_identityHash: { ...scope, identityHash } },
        select: { id: true, active: true, expiresAt: true },
      });
      if (existing && isBanActive(existing, now)) {
        await tx.radarZoneEvent.updateMany({
          where: { id: event.id, autoBanStatus: RadarAutoBanStatus.PROCESSING },
          data: {
            autoBanStatus: RadarAutoBanStatus.APPLIED,
            autoBanBanId: existing.id,
            autoBanProcessedAt: now,
            autoBanLeaseUntil: null,
            autoBanLastError: 'ALREADY_ACTIVE_BAN',
          },
        });
        return { kind: 'ALREADY_BANNED' as const, banId: existing.id, event };
      }

      await tx.whitelistEntry.updateMany({
        where: { guildId: event.guildId, nitradoConnId: event.nitradoConnId, gameId: validation.identifier },
        data: { syncState: 'PENDING_REMOVE', lastSyncedAt: null },
      });
      await tx.whitelistRequest.updateMany({
        where: {
          guildId: event.guildId,
          nitradoConnId: event.nitradoConnId,
          gameId: validation.identifier,
          status: { in: ['PENDING', 'APPROVED'] },
        },
        data: { status: 'CANCELLED' },
      });

      await addBan(
        tx as unknown as BanClient,
        scope,
        {
          identityHash,
          gameLabel: validation.actorName,
          reason: validation.reason,
          bannedByDiscordId: event.autoBanAuthorizedBy!,
          expiresAt: null,
        },
        now,
      );
      const ban = await tx.serverBanEntry.findUnique({
        where: { guildId_nitradoConnId_identityHash: { ...scope, identityHash } },
        select: { id: true },
      });
      if (!ban) throw new Error('Radar-Auto-Ban konnte nach Registry-Upsert nicht wiedergefunden werden.');

      const queued = await enqueueServerBanAdd(
        tx as unknown as BanOutboxClient,
        scope,
        ban.id,
        validation.identifier,
        config.security.encryptionKey,
      );
      await tx.radarZoneEvent.updateMany({
        where: { id: event.id, autoBanStatus: RadarAutoBanStatus.PROCESSING },
        data: {
          autoBanStatus: RadarAutoBanStatus.APPLIED,
          autoBanBanId: ban.id,
          autoBanProcessedAt: now,
          autoBanLeaseUntil: null,
          autoBanLastError: null,
        },
      });
      return { kind: 'APPLIED' as const, banId: ban.id, queued, event };
    });

    if (outcome.kind === 'APPLIED' || outcome.kind === 'ALREADY_BANNED') {
      logAudit('RADAR_AUTO_BAN_APPLIED', 'MODERATION', {
        guildId: outcome.event.guildId,
        nitradoConnId: outcome.event.nitradoConnId,
        zoneId: outcome.event.zoneId,
        radarEventId: outcome.event.id,
        admEventId: outcome.event.admEventId,
        functionKey: outcome.event.functionKey,
        zoneVersion: outcome.event.zoneVersionSnapshot,
        banId: outcome.banId,
        alreadyActive: outcome.kind === 'ALREADY_BANNED',
        remoteQueued: outcome.kind === 'APPLIED' ? outcome.queued : false,
        safetyMarginMeters: AUTO_BAN_SAFETY_MARGIN_METERS,
      });
    } else if (outcome.kind === 'SKIPPED') {
      logAudit('RADAR_AUTO_BAN_SKIPPED', 'MODERATION', {
        guildId: outcome.event.guildId,
        nitradoConnId: outcome.event.nitradoConnId,
        zoneId: outcome.event.zoneId,
        radarEventId: outcome.event.id,
        admEventId: outcome.event.admEventId,
        functionKey: outcome.event.functionKey,
        code: outcome.code,
      });
    }
  } catch (error) {
    const nextAttempt = attempts + 1;
    const failed = nextAttempt >= MAX_ATTEMPTS;
    const message = safeError(error);
    await prisma.radarZoneEvent.updateMany({
      where: { id: eventId, autoBanStatus: RadarAutoBanStatus.PROCESSING },
      data: {
        autoBanStatus: failed ? RadarAutoBanStatus.FAILED : RadarAutoBanStatus.RETRY,
        autoBanAttempts: nextAttempt,
        autoBanNextAttemptAt: new Date(Date.now() + retryDelayMs(nextAttempt)),
        autoBanLeaseUntil: null,
        autoBanLastError: message,
      },
    });
    logger.error(`Radar-Auto-Ban ${eventId} fehlgeschlagen: ${message}`);
  }
}

export async function runRadarAutoBanOnce(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const now = new Date();
    await prisma.radarZoneEvent.updateMany({
      where: {
        autoBanStatus: RadarAutoBanStatus.PROCESSING,
        autoBanLeaseUntil: { lt: now },
        autoBanAttempts: { gte: MAX_ATTEMPTS - 1 },
      },
      data: {
        autoBanStatus: RadarAutoBanStatus.FAILED,
        autoBanAttempts: { increment: 1 },
        autoBanLeaseUntil: null,
        autoBanLastError: 'AUTO_BAN_LEASE_EXPIRED_MAX_ATTEMPTS',
      },
    });
    await prisma.radarZoneEvent.updateMany({
      where: {
        autoBanStatus: RadarAutoBanStatus.PROCESSING,
        autoBanLeaseUntil: { lt: now },
        autoBanAttempts: { lt: MAX_ATTEMPTS - 1 },
      },
      data: {
        autoBanStatus: RadarAutoBanStatus.RETRY,
        autoBanAttempts: { increment: 1 },
        autoBanNextAttemptAt: now,
        autoBanLeaseUntil: null,
        autoBanLastError: 'AUTO_BAN_LEASE_EXPIRED_RETRY',
      },
    });

    for (let index = 0; index < BATCH_SIZE; index += 1) {
      const event = await prisma.radarZoneEvent.findFirst({
        where: {
          autoBanStatus: { in: [RadarAutoBanStatus.PENDING, RadarAutoBanStatus.RETRY] },
          autoBanNextAttemptAt: { lte: new Date() },
        },
        orderBy: [{ autoBanNextAttemptAt: 'asc' }, { createdAt: 'asc' }],
        select: { id: true, autoBanAttempts: true },
      });
      if (!event) break;
      await processAutoBanEvent(event.id, event.autoBanAttempts);
    }
  } finally {
    running = false;
  }
}

export function startRadarAutoBanRuntime(): void {
  if (timer) return;
  timer = setInterval(() => { void runRadarAutoBanOnce(); }, POLL_INTERVAL_MS);
  timer.unref?.();
  void runRadarAutoBanOnce();
  logger.info(`Radar-Auto-Ban gestartet (Intervall ${POLL_INTERVAL_MS / 1000}s, Sicherheitsrand ${AUTO_BAN_SAFETY_MARGIN_METERS}m).`);
}

export function stopRadarAutoBanRuntime(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

export { AUTO_BAN_SAFETY_MARGIN_METERS };
