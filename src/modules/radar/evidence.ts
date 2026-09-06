import type { Prisma, PrismaClient } from '@prisma/client';
import { parseAdmDayzPosition } from '../../shared/radarCoordinates';
import { admBindingFileIdentityPrefix } from '../nitrado/adm/bindingState';
import type {
  RadarAdmEvent,
  RadarFunctionDefinition,
  RadarPositionCandidate,
} from './catalog';

export const DISCONNECT_POSITION_MAX_AGE_MS = 6 * 60_000;

export interface RadarEvidenceScope {
  guildId: string;
  nitradoConnId: string;
}

type RadarEvidenceClient = PrismaClient | Prisma.TransactionClient;

type PositionEvidenceRow = {
  id: string;
  sourceFile: string;
  occurredAt: Date | null;
  actorPosition: string | null;
  actorName: string | null;
};

function sourceBelongsToBinding(sourceFile: string, bindingVersion: number): boolean {
  const prefix = admBindingFileIdentityPrefix(bindingVersion);
  return prefix ? sourceFile.startsWith(prefix) : !sourceFile.startsWith('adm-binding:');
}

/**
 * Resolve the exact player position used by a radar policy.
 *
 * Most policies are completely self-contained in one ADM line and use the
 * catalog's synchronous selector. Disconnect is the only exception: vanilla
 * DayZ emits no position on the disconnect line, so we require a recent
 * PLAYER_POSITION after the latest connect, from the same ADM binding
 * generation. Missing/old/cross-generation evidence yields no candidate.
 */
export async function resolveRadarCandidates(
  client: RadarEvidenceClient,
  definition: RadarFunctionDefinition,
  event: RadarAdmEvent,
  scope: RadarEvidenceScope,
): Promise<RadarPositionCandidate[]> {
  if (definition.key !== 'BAN_DISCONNECT') return definition.selectPositions(event);
  if (event.eventType !== 'PLAYER_DISCONNECTED' || !event.actorGameId || !event.occurredAt) return [];

  const binding = await client.nitradoAdmBindingState.findUnique({
    where: { guildId_nitradoConnId: { guildId: scope.guildId, nitradoConnId: scope.nitradoConnId } },
    select: { bindingVersion: true, currentServiceId: true },
  });
  if (!binding?.currentServiceId) return [];

  const connectedRows = await client.admEvent.findMany({
    where: {
      guildId: scope.guildId,
      nitradoConnId: scope.nitradoConnId,
      eventType: 'PLAYER_CONNECTED',
      actorGameId: event.actorGameId,
      occurredAt: { lte: event.occurredAt },
    },
    orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }],
    take: 12,
    select: { id: true, sourceFile: true, occurredAt: true, actorPosition: true, actorName: true },
  }) as PositionEvidenceRow[];
  const connected = connectedRows.find(row => row.occurredAt && sourceBelongsToBinding(row.sourceFile, binding.bindingVersion));
  if (!connected?.occurredAt) return [];

  const freshnessFloor = new Date(event.occurredAt.getTime() - DISCONNECT_POSITION_MAX_AGE_MS);
  const sessionFloor = connected.occurredAt > freshnessFloor ? connected.occurredAt : freshnessFloor;

  const positionRows = await client.admEvent.findMany({
    where: {
      guildId: scope.guildId,
      nitradoConnId: scope.nitradoConnId,
      eventType: 'PLAYER_POSITION',
      actorGameId: event.actorGameId,
      occurredAt: { gt: sessionFloor, lte: event.occurredAt },
    },
    orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }],
    take: 12,
    select: { id: true, sourceFile: true, occurredAt: true, actorPosition: true, actorName: true },
  }) as PositionEvidenceRow[];

  for (const row of positionRows) {
    if (!row.occurredAt || !sourceBelongsToBinding(row.sourceFile, binding.bindingVersion)) continue;
    if (event.occurredAt.getTime() - row.occurredAt.getTime() > DISCONNECT_POSITION_MAX_AGE_MS) continue;
    const position = parseAdmDayzPosition(row.actorPosition);
    if (!position) continue;
    return [{
      identity: 'ACTOR',
      gameId: event.actorGameId,
      playerName: event.actorName ?? row.actorName,
      position,
      relatedGameId: null,
      relatedName: null,
    }];
  }

  return [];
}
