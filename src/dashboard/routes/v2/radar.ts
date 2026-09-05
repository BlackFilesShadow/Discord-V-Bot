import { Router, type Request, type Response } from 'express';
import { PermissionFlagsBits } from 'discord.js';
import type { Prisma } from '@prisma/client';
import { requireGuildPermission } from '../../middleware/auth';
import prisma from '../../../database/prisma';
import { validateBotChannelAccess } from '../../../utils/discordChannel';
import { isValidBattleyeGuid } from '../../../utils/guid';
import { tryGetDashboardClient } from '../../clientRegistry';
import { emitGuildEvent } from '../../socket/emitter';
import { resolveDashboardGameServer, sendDashboardServerResolutionError } from './serverScope';
import { RADAR_FUNCTIONS, radarFunctionByKey } from '../../../modules/radar/catalog';
import {
  createCircleGeometry,
  createPolygonGeometry,
  geometryFitsMap,
  type RadarGeometry,
  type RadarPoint,
} from '../../../modules/radar/geometry';
import type { RadarMap } from '../../../shared/radarCoordinates';

export const radarRouter = Router({ mergeParams: true });

const SNOWFLAKE_RE = /^\d{17,20}$/;
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const MAPS = new Set<RadarMap>(['CHERNARUS', 'LIVONIA', 'SAKHAL']);

type SaveBody = {
  version?: number;
  name?: string;
  map?: RadarMap;
  isActive?: boolean;
  geometry?: { type?: string; x?: number; y?: number; radiusMeters?: number; points?: RadarPoint[] };
  enabledFunctions?: string[];
  allowlist?: Array<{ source?: 'SERVER_WHITELIST' | 'MANUAL'; gameId?: string; playerName?: string | null }>;
  channelId?: string;
  rolePingEnabled?: boolean;
  roleIds?: string[];
  embedColor?: string;
  editorState?: { centerX?: number; centerY?: number; zoom?: number; bearing?: number; pitch?: number };
};

type RadarZoneWithRelations = Prisma.RadarZoneGetPayload<{
  include: { points: true; functions: true; allowlist: true };
}>;

async function scopeFor(req: Request, res: Response) {
  const scope = req.guildScope!;
  const resolution = await resolveDashboardGameServer(scope.guildId, scope.actorDiscordId, req.query.slot);
  if (resolution.kind !== 'RESOLVED') {
    sendDashboardServerResolutionError(res, resolution);
    return null;
  }
  return { guildId: scope.guildId, connId: resolution.nitradoConnId, actorId: scope.actorDiscordId };
}

async function channelError(guildId: string, channelId: string): Promise<string | null> {
  const client = tryGetDashboardClient();
  if (!client) return 'Discord-Client ist derzeit nicht verfuegbar.';
  const result = await validateBotChannelAccess(client, guildId, channelId, [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
  ]);
  return result.ok ? null : result.reason;
}

async function roleError(guildId: string, roleIds: readonly string[]): Promise<string | null> {
  if (roleIds.length === 0) return null;
  const client = tryGetDashboardClient();
  const guild = client?.guilds.cache.get(guildId);
  if (!guild) return 'Discord-Guild ist derzeit nicht verfuegbar.';
  for (const roleId of roleIds) {
    if (roleId === guild.id) return '@everyone kann nicht als Radar-Ping verwendet werden.';
    const role = guild.roles.cache.get(roleId) ?? await guild.roles.fetch(roleId).catch(() => null);
    if (!role) return 'Eine Radar-Rolle existiert nicht oder ist fuer den Bot nicht sichtbar.';
    if (role.managed) return 'Von Integrationen verwaltete Rollen sind nicht als Radar-Ping erlaubt.';
  }
  return null;
}

async function ensureRadarConfig(guildId: string, nitradoConnId: string, activeMap?: RadarMap) {
  const highWatermark = await prisma.admEvent.findFirst({
    where: { guildId, nitradoConnId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { createdAt: true, id: true },
  });
  return prisma.radarConfig.upsert({
    where: { guildId_nitradoConnId: { guildId, nitradoConnId } },
    create: {
      guildId,
      nitradoConnId,
      ...(activeMap ? { activeMap } : {}),
      ...(highWatermark ? { cursorCreatedAt: highWatermark.createdAt, cursorEventId: highWatermark.id } : {}),
    },
    update: activeMap ? { activeMap } : {},
  });
}

function readMap(value: unknown): RadarMap | null {
  const map = String(value ?? '').trim().toUpperCase() as RadarMap;
  return MAPS.has(map) ? map : null;
}

function geometryFrom(body: SaveBody, map: RadarMap): RadarGeometry | null {
  const raw = body.geometry;
  if (!raw) return null;
  const geometry = raw.type === 'CIRCLE'
    ? createCircleGeometry(Number(raw.x), Number(raw.y), Number(raw.radiusMeters))
    : raw.type === 'POLYGON' && Array.isArray(raw.points)
      ? createPolygonGeometry(raw.points)
      : null;
  return geometry && geometryFitsMap(map, geometry) ? geometry : null;
}

function validateBody(body: SaveBody): { ok: true; data: Required<Pick<SaveBody, 'name' | 'map' | 'isActive' | 'enabledFunctions' | 'allowlist' | 'channelId' | 'rolePingEnabled' | 'roleIds' | 'embedColor'>> & { geometry: RadarGeometry; editorState: NonNullable<SaveBody['editorState']> } } | { ok: false; error: string } {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const map = readMap(body.map);
  if (!name || name.length > 120 || !map || typeof body.isActive !== 'boolean') return { ok: false, error: 'Name, Karte und Aktivstatus sind ungueltig.' };
  const geometry = geometryFrom(body, map);
  if (!geometry) return { ok: false, error: 'Zonen-Geometrie ist ungueltig oder liegt ausserhalb der Karte.' };
  if (!Array.isArray(body.enabledFunctions) || new Set(body.enabledFunctions).size !== body.enabledFunctions.length || body.enabledFunctions.some(key => !radarFunctionByKey(key))) return { ok: false, error: 'Funktionskatalog ist ungueltig.' };
  if (!Array.isArray(body.allowlist) || body.allowlist.some(entry => !entry || !isValidBattleyeGuid(entry.gameId) || (entry.playerName != null && (typeof entry.playerName !== 'string' || entry.playerName.length > 128)))) return { ok: false, error: 'Allowlist verlangt gueltige GUID-Eintraege.' };
  if (body.allowlist.length > 0 && new Set(body.allowlist.map(entry => entry.gameId!.trim())).size !== body.allowlist.length) return { ok: false, error: 'Allowlist-GUIDs duerfen nicht doppelt vorkommen.' };
  if (typeof body.channelId !== 'string' || !SNOWFLAKE_RE.test(body.channelId)) return { ok: false, error: 'channelId muss Discord-Snowflake sein.' };
  if (typeof body.rolePingEnabled !== 'boolean' || !Array.isArray(body.roleIds) || body.roleIds.length > 8 || new Set(body.roleIds).size !== body.roleIds.length || body.roleIds.some(id => typeof id !== 'string' || !SNOWFLAKE_RE.test(id))) return { ok: false, error: 'Rollen-Ping oder Rollen sind ungueltig.' };
  if (body.rolePingEnabled && body.roleIds.length === 0) return { ok: false, error: 'Aktiver Rollen-Ping benoetigt mindestens eine Rolle.' };
  if (typeof body.embedColor !== 'string' || !HEX_RE.test(body.embedColor)) return { ok: false, error: 'embedColor muss Hex sein (z.B. #dc2626).' };
  return { ok: true, data: { name, map, isActive: body.isActive, geometry, enabledFunctions: body.enabledFunctions, allowlist: body.allowlist, channelId: body.channelId, rolePingEnabled: body.rolePingEnabled, roleIds: body.roleIds, embedColor: body.embedColor, editorState: body.editorState ?? {} } };
}

function zoneResponse(zone: RadarZoneWithRelations) {
  return {
    id: zone.id, name: zone.name, map: zone.map, isActive: zone.isActive, channelId: zone.channelId,
    rolePingEnabled: zone.rolePingEnabled, roleIds: zone.roleIds, embedColor: zone.embedColor, version: zone.version,
    geometry: zone.shape === 'CIRCLE'
      ? { type: 'CIRCLE', x: Number(zone.centerX), y: Number(zone.centerY), radiusMeters: Number(zone.radiusMeters) }
      : { type: 'POLYGON', points: zone.points.map(point => ({ x: Number(point.x), y: Number(point.y) })) },
    enabledFunctions: zone.functions.map(entry => entry.functionKey),
    allowlist: zone.allowlist.map(entry => ({ source: entry.source, gameId: entry.gameId, playerName: entry.playerName })),
    editorState: { centerX: zone.editorCenterX === null ? undefined : Number(zone.editorCenterX), centerY: zone.editorCenterY === null ? undefined : Number(zone.editorCenterY), zoom: zone.editorZoom === null ? undefined : Number(zone.editorZoom), bearing: zone.editorBearing === null ? undefined : Number(zone.editorBearing), pitch: zone.editorPitch === null ? undefined : Number(zone.editorPitch) },
  };
}

radarRouter.get('/config', requireGuildPermission('radar.view'), async (req, res) => {
  const scope = await scopeFor(req, res); if (!scope) return;
  const config = await ensureRadarConfig(scope.guildId, scope.connId);
  res.json({ activeMap: config.activeMap, nitradoConnId: scope.connId });
});

radarRouter.get('/players', requireGuildPermission('radar.manage'), async (req, res) => {
  const scope = await scopeFor(req, res); if (!scope) return;
  const sessions = await prisma.playerSession.findMany({
    where: { guildId: scope.guildId, nitradoConnId: scope.connId, playerName: { not: null } },
    select: { gameId: true, playerName: true },
    orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    take: 2000,
  });
  const gameIds = new Set<string>();
  const players = sessions.flatMap(session => {
    const gameId = session.gameId.trim();
    const playerName = session.playerName?.trim();
    if (!playerName || !isValidBattleyeGuid(gameId) || gameIds.has(gameId)) return [];
    gameIds.add(gameId);
    return [{ gameId, playerName }];
  });
  res.json({ players });
});

radarRouter.put('/config', requireGuildPermission('radar.manage'), async (req, res) => {
  const scope = await scopeFor(req, res); if (!scope) return;
  const activeMap = readMap(req.body?.activeMap); if (!activeMap) { res.status(400).json({ error: 'activeMap ist ungueltig.' }); return; }
  const config = await ensureRadarConfig(scope.guildId, scope.connId, activeMap);
  emitGuildEvent(scope.guildId, { type: 'radar.changed', payload: { guildId: scope.guildId, nitradoConnId: scope.connId } });
  res.json({ activeMap: config.activeMap, nitradoConnId: scope.connId });
});

radarRouter.get('/functions', requireGuildPermission('radar.view'), (_req, res) => res.json({ functions: RADAR_FUNCTIONS.map(({ selectPositions: _selector, ...definition }) => definition) }));

radarRouter.get('/zones', requireGuildPermission('radar.view'), async (req, res) => {
  const scope = await scopeFor(req, res); if (!scope) return;
  const map = req.query.map === undefined ? undefined : readMap(req.query.map); if (req.query.map !== undefined && !map) { res.status(400).json({ error: 'map ist ungueltig.' }); return; }
  const zones = await prisma.radarZone.findMany({ where: { guildId: scope.guildId, nitradoConnId: scope.connId, ...(map ? { map } : {}) }, include: { points: { orderBy: { position: 'asc' } }, functions: { orderBy: { functionKey: 'asc' } }, allowlist: { orderBy: { gameId: 'asc' } } }, orderBy: { name: 'asc' } });
  res.json({ zones: zones.map(zoneResponse) });
});

radarRouter.get('/zones/:zoneId', requireGuildPermission('radar.view'), async (req, res) => {
  const scope = await scopeFor(req, res); if (!scope) return;
  const zone = await prisma.radarZone.findFirst({ where: { id: req.params.zoneId, guildId: scope.guildId, nitradoConnId: scope.connId }, include: { points: { orderBy: { position: 'asc' } }, functions: { orderBy: { functionKey: 'asc' } }, allowlist: { orderBy: { gameId: 'asc' } } } });
  if (!zone) { res.status(404).json({ error: 'Radar-Zone nicht gefunden.' }); return; }
  res.json({ zone: zoneResponse(zone) });
});

radarRouter.post('/zones', requireGuildPermission('radar.manage'), async (req, res) => {
  const scope = await scopeFor(req, res); if (!scope) return;
  const checked = validateBody(req.body ?? {}); if (!checked.ok) { res.status(400).json({ error: checked.error }); return; }
  const channelValidation = await channelError(scope.guildId, checked.data.channelId); if (channelValidation) { res.status(400).json({ error: channelValidation }); return; }
  const roleValidation = await roleError(scope.guildId, checked.data.roleIds); if (roleValidation) { res.status(400).json({ error: roleValidation }); return; }
  const config = await ensureRadarConfig(scope.guildId, scope.connId);
  const data = checked.data;
  const zone = await prisma.radarZone.create({
    data: {
      configId: config.id,
      guildId: scope.guildId,
      nitradoConnId: scope.connId,
      name: data.name,
      map: data.map,
      shape: data.geometry.shape,
      isActive: data.isActive,
      centerX: data.geometry.shape === 'CIRCLE' ? data.geometry.centerX : null,
      centerY: data.geometry.shape === 'CIRCLE' ? data.geometry.centerY : null,
      radiusMeters: data.geometry.shape === 'CIRCLE' ? data.geometry.radiusMeters : null,
      minX: data.geometry.minX,
      minY: data.geometry.minY,
      maxX: data.geometry.maxX,
      maxY: data.geometry.maxY,
      channelId: data.channelId,
      rolePingEnabled: data.rolePingEnabled,
      roleIds: data.roleIds,
      embedColor: data.embedColor,
      editorCenterX: data.editorState.centerX,
      editorCenterY: data.editorState.centerY,
      editorZoom: data.editorState.zoom,
      editorBearing: data.editorState.bearing,
      editorPitch: data.editorState.pitch,
      createdBy: scope.actorId,
      updatedBy: scope.actorId,
      points: { create: data.geometry.shape === 'POLYGON' ? data.geometry.points.map((point, position) => ({ position, x: point.x, y: point.y })) : [] },
      functions: { create: data.enabledFunctions.map(functionKey => ({ functionKey })) },
      allowlist: { create: data.allowlist.map(entry => ({ source: entry.source === 'SERVER_WHITELIST' ? 'SERVER_WHITELIST' : 'MANUAL', gameId: entry.gameId!.trim(), playerName: entry.playerName?.trim() || null })) },
    },
    include: { points: { orderBy: { position: 'asc' } }, functions: true, allowlist: true },
  });
  emitGuildEvent(scope.guildId, { type: 'radar.changed', payload: { guildId: scope.guildId, nitradoConnId: scope.connId, zoneId: zone.id } });
  res.status(201).json({ zone: zoneResponse(zone) });
});

radarRouter.put('/zones/:zoneId', requireGuildPermission('radar.manage'), async (req, res) => {
  const scope = await scopeFor(req, res); if (!scope) return;
  const checked = validateBody(req.body ?? {}); if (!checked.ok) { res.status(400).json({ error: checked.error }); return; }
  if (!Number.isInteger(req.body?.version) || req.body.version < 1) { res.status(400).json({ error: 'version ist erforderlich.' }); return; }
  const channelValidation = await channelError(scope.guildId, checked.data.channelId); if (channelValidation) { res.status(400).json({ error: channelValidation }); return; }
  const roleValidation = await roleError(scope.guildId, checked.data.roleIds); if (roleValidation) { res.status(400).json({ error: roleValidation }); return; }
  const data = checked.data;
  const updated = await prisma.$transaction(async tx => {
    const result = await tx.radarZone.updateMany({
      where: { id: req.params.zoneId, guildId: scope.guildId, nitradoConnId: scope.connId, version: req.body.version },
      data: {
        name: data.name, map: data.map, shape: data.geometry.shape, isActive: data.isActive,
        centerX: data.geometry.shape === 'CIRCLE' ? data.geometry.centerX : null,
        centerY: data.geometry.shape === 'CIRCLE' ? data.geometry.centerY : null,
        radiusMeters: data.geometry.shape === 'CIRCLE' ? data.geometry.radiusMeters : null,
        minX: data.geometry.minX, minY: data.geometry.minY, maxX: data.geometry.maxX, maxY: data.geometry.maxY,
        channelId: data.channelId, rolePingEnabled: data.rolePingEnabled, roleIds: data.roleIds, embedColor: data.embedColor,
        editorCenterX: data.editorState.centerX, editorCenterY: data.editorState.centerY, editorZoom: data.editorState.zoom, editorBearing: data.editorState.bearing, editorPitch: data.editorState.pitch,
        updatedBy: scope.actorId, version: { increment: 1 },
      },
    });
    if (result.count !== 1) return null;
    await Promise.all([
      tx.radarZonePoint.deleteMany({ where: { zoneId: req.params.zoneId } }),
      tx.radarZoneFunction.deleteMany({ where: { zoneId: req.params.zoneId } }),
      tx.radarZoneAllowlist.deleteMany({ where: { zoneId: req.params.zoneId } }),
    ]);
    if (data.geometry.shape === 'POLYGON') {
      await tx.radarZonePoint.createMany({ data: data.geometry.points.map((point, position) => ({ zoneId: req.params.zoneId, position, x: point.x, y: point.y })) });
    }
    await Promise.all([
      tx.radarZoneFunction.createMany({ data: data.enabledFunctions.map(functionKey => ({ zoneId: req.params.zoneId, functionKey })) }),
      tx.radarZoneAllowlist.createMany({ data: data.allowlist.map(entry => ({ zoneId: req.params.zoneId, source: entry.source === 'SERVER_WHITELIST' ? 'SERVER_WHITELIST' : 'MANUAL', gameId: entry.gameId!.trim(), playerName: entry.playerName?.trim() || null })) }),
    ]);
    return tx.radarZone.findFirst({ where: { id: req.params.zoneId, guildId: scope.guildId, nitradoConnId: scope.connId }, include: { points: { orderBy: { position: 'asc' } }, functions: { orderBy: { functionKey: 'asc' } }, allowlist: { orderBy: { gameId: 'asc' } } } });
  });
  if (!updated) { res.status(409).json({ error: 'Radar-Zone wurde zwischenzeitlich geändert oder nicht gefunden.' }); return; }
  emitGuildEvent(scope.guildId, { type: 'radar.changed', payload: { guildId: scope.guildId, nitradoConnId: scope.connId, zoneId: updated.id } });
  res.json({ zone: zoneResponse(updated) });
});

radarRouter.delete('/zones/:zoneId', requireGuildPermission('radar.manage'), async (req, res) => {
  const scope = await scopeFor(req, res); if (!scope) return;
  const result = await prisma.radarZone.deleteMany({ where: { id: req.params.zoneId, guildId: scope.guildId, nitradoConnId: scope.connId } });
  if (result.count !== 1) { res.status(404).json({ error: 'Radar-Zone nicht gefunden.' }); return; }
  emitGuildEvent(scope.guildId, { type: 'radar.zone.deleted', payload: { guildId: scope.guildId, nitradoConnId: scope.connId, zoneId: req.params.zoneId } });
  res.status(204).end();
});