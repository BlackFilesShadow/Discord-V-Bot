import type { AdmEventType } from '@prisma/client';
import {
  parseAdmDayzPosition,
  parseAdmTerritoryFlagPosition,
  type DayzPosition,
} from '../../shared/radarCoordinates';

export interface RadarAdmEvent {
  id: string;
  eventType: AdmEventType;
  occurredAt: Date | null;
  actorGameId: string | null;
  actorName: string | null;
  targetGameId: string | null;
  targetName: string | null;
  objectType: string | null;
  toolOrWeapon: string | null;
  distanceMeters: number | null;
  actorPosition: string | null;
  targetPosition: string | null;
  rawLine?: string | null;
}

export interface RadarPositionCandidate {
  /** Which ADM identity is the player responsible for this radar action. */
  identity: 'ACTOR' | 'TARGET';
  gameId: string | null;
  playerName: string | null;
  /** The exact X/Z/height evidence used to decide whether the action is in-zone. */
  position: DayzPosition;
  /** Optional counterpart shown in the event (victim, target player, flag, ...). */
  relatedGameId: string | null;
  relatedName: string | null;
}

export interface RadarFunctionDefinition {
  key: string;
  label: string;
  order: number;
  defaultEnabled: boolean;
  /** Only punitive functions are eligible for the server-ban worker. */
  punitive: boolean;
  sourceEvents: readonly AdmEventType[];
  selectPositions(event: RadarAdmEvent): RadarPositionCandidate[];
}

const EXPLOSIVE_EVIDENCE_RE = /(?:\bexplosion\b|\bgrenade\b|\bm79\b|\b40\s*mm\b|\bclaymore\b|plastic[_\s-]*explosive|land[_\s-]*mine|rgd5|m67|flashbang|grenade[_\s-]*ammo)/i;

export function isExplosiveRadarEvent(event: RadarAdmEvent): boolean {
  const evidence = [event.toolOrWeapon, event.objectType, event.rawLine].filter(Boolean).join(' ');
  return EXPLOSIVE_EVIDENCE_RE.test(evidence);
}

function candidate(
  identity: 'ACTOR' | 'TARGET',
  gameId: string | null,
  playerName: string | null,
  position: DayzPosition | null,
  relatedGameId: string | null,
  relatedName: string | null,
): RadarPositionCandidate[] {
  return position ? [{ identity, gameId, playerName, position, relatedGameId, relatedName }] : [];
}

function actorPosition(event: RadarAdmEvent): RadarPositionCandidate[] {
  return candidate(
    'ACTOR',
    event.actorGameId,
    event.actorName,
    parseAdmDayzPosition(event.actorPosition),
    event.targetGameId,
    event.targetName,
  );
}

function attackingPlayerPosition(event: RadarAdmEvent): RadarPositionCandidate[] {
  if (!event.targetGameId || event.targetGameId === event.actorGameId) return [];
  return candidate(
    'TARGET',
    event.targetGameId,
    event.targetName,
    parseAdmDayzPosition(event.targetPosition),
    event.actorGameId,
    event.actorName,
  );
}

function nonExplosiveAttacker(event: RadarAdmEvent): RadarPositionCandidate[] {
  return isExplosiveRadarEvent(event) ? [] : attackingPlayerPosition(event);
}

function explosiveAttacker(event: RadarAdmEvent): RadarPositionCandidate[] {
  return isExplosiveRadarEvent(event) ? attackingPlayerPosition(event) : [];
}

function territoryFlagPosition(event: RadarAdmEvent): RadarPositionCandidate[] {
  if (event.eventType !== 'UNKNOWN' || event.targetName !== 'TerritoryFlag' || !event.objectType) return [];
  return candidate(
    'ACTOR',
    event.actorGameId,
    event.actorName,
    parseAdmTerritoryFlagPosition(event.targetPosition),
    null,
    'TerritoryFlag',
  );
}

function noDirectPosition(): RadarPositionCandidate[] {
  return [];
}

const catalog: readonly RadarFunctionDefinition[] = [
  {
    key: 'PLAYER_DETECTION',
    label: 'Spieler-Erkennung',
    order: 10,
    defaultEnabled: true,
    punitive: false,
    sourceEvents: ['PLAYER_POSITION'],
    selectPositions: actorPosition,
  },
  {
    key: 'BAN_PLAYER_DETECTION',
    label: 'Bann bei Spieler-Erkennung',
    order: 20,
    defaultEnabled: false,
    punitive: true,
    sourceEvents: ['PLAYER_POSITION'],
    selectPositions: actorPosition,
  },
  {
    key: 'BAN_PLACEMENT',
    label: 'Bann bei Platzierung',
    order: 30,
    defaultEnabled: false,
    punitive: true,
    sourceEvents: ['PLACEMENT'],
    selectPositions: actorPosition,
  },
  {
    key: 'BAN_BUILD',
    label: 'Bann bei Bauen',
    order: 40,
    defaultEnabled: false,
    punitive: true,
    sourceEvents: ['BUILD'],
    selectPositions: actorPosition,
  },
  {
    key: 'BAN_DISMANTLE',
    label: 'Bann bei Demontage',
    order: 50,
    defaultEnabled: false,
    punitive: true,
    sourceEvents: ['DISMANTLE'],
    selectPositions: actorPosition,
  },
  {
    key: 'BAN_DESTROY',
    label: 'Bann bei Zerstörung',
    order: 60,
    defaultEnabled: false,
    punitive: true,
    sourceEvents: ['DESTROY'],
    selectPositions: actorPosition,
  },
  {
    key: 'BAN_FLAG',
    label: 'Bann bei Flagge hoch/runter',
    order: 70,
    defaultEnabled: false,
    punitive: true,
    // Flag activities are intentionally persisted in AdmEvent as UNKNOWN and
    // separately typed in FlagActivityEvent. The strict TerritoryFlag selector
    // below prevents unrelated UNKNOWN lines from ever becoming radar events.
    sourceEvents: ['UNKNOWN'],
    selectPositions: territoryFlagPosition,
  },
  {
    key: 'BAN_DISCONNECT',
    label: 'Bann bei Disconnect',
    order: 80,
    defaultEnabled: false,
    punitive: true,
    sourceEvents: ['PLAYER_DISCONNECTED'],
    // A disconnect line has no coordinates. evidence.ts resolves only a fresh
    // PLAYER_POSITION from the same GUID/session/binding; otherwise fail closed.
    selectPositions: noDirectPosition,
  },
  {
    key: 'BAN_HIT',
    label: 'Bann bei Hit',
    order: 90,
    defaultEnabled: false,
    punitive: true,
    sourceEvents: ['PLAYER_HIT'],
    selectPositions: nonExplosiveAttacker,
  },
  {
    key: 'BAN_KILL',
    label: 'Bann bei Kill',
    order: 100,
    defaultEnabled: false,
    punitive: true,
    sourceEvents: ['PLAYER_KILLED'],
    selectPositions: nonExplosiveAttacker,
  },
  {
    key: 'BAN_EXPLOSION',
    label: 'Bann bei Explosion',
    order: 110,
    defaultEnabled: false,
    punitive: true,
    sourceEvents: ['PLAYER_HIT', 'PLAYER_KILLED'],
    // Explosion without a player GUID + player position yields no candidate.
    // No proximity guesses or victim bans are permitted.
    selectPositions: explosiveAttacker,
  },
];

export const RADAR_FUNCTIONS: readonly RadarFunctionDefinition[] = [...catalog].sort((a, b) => a.order - b.order);

export function radarFunctionsForEvent(eventType: AdmEventType): readonly RadarFunctionDefinition[] {
  return RADAR_FUNCTIONS.filter(definition => definition.sourceEvents.includes(eventType));
}

export function radarFunctionByKey(key: string): RadarFunctionDefinition | null {
  return RADAR_FUNCTIONS.find(definition => definition.key === key) ?? null;
}

export function radarHasPunitiveFunction(keys: readonly string[]): boolean {
  return keys.some(key => radarFunctionByKey(key)?.punitive === true);
}
