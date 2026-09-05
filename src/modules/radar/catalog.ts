import type { AdmEventType } from '@prisma/client';
import { parseAdmDayzPosition, type DayzPosition } from '../../shared/radarCoordinates';

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
}

export interface RadarPositionCandidate {
  identity: 'ACTOR' | 'TARGET';
  gameId: string | null;
  playerName: string | null;
  position: DayzPosition;
}

export interface RadarFunctionDefinition {
  key: string;
  label: string;
  order: number;
  defaultEnabled: boolean;
  sourceEvents: readonly AdmEventType[];
  selectPositions(event: RadarAdmEvent): RadarPositionCandidate[];
}

function actorPosition(event: RadarAdmEvent): RadarPositionCandidate[] {
  const position = parseAdmDayzPosition(event.actorPosition);
  return position ? [{ identity: 'ACTOR', gameId: event.actorGameId, playerName: event.actorName, position }] : [];
}

function flagPosition(event: RadarAdmEvent): RadarPositionCandidate[] {
  const position = parseAdmDayzPosition(event.targetPosition);
  return position ? [{ identity: 'TARGET', gameId: event.actorGameId, playerName: event.actorName, position }] : [];
}

const catalog: readonly RadarFunctionDefinition[] = [
  {
    key: 'PLAYER_DETECTION',
    label: 'Spieler-Erkennung',
    order: 10,
    defaultEnabled: true,
    sourceEvents: ['PLAYER_POSITION'],
    selectPositions: actorPosition,
  },
  {
    key: 'PLACEMENT',
    label: 'Platzierung',
    order: 20,
    defaultEnabled: false,
    sourceEvents: ['PLACEMENT'],
    selectPositions: actorPosition,
  },
  {
    key: 'BUILD',
    label: 'Bauen',
    order: 30,
    defaultEnabled: false,
    sourceEvents: ['BUILD'],
    selectPositions: actorPosition,
  },
  {
    key: 'DISMANTLE',
    label: 'Demontage',
    order: 40,
    defaultEnabled: false,
    sourceEvents: ['DISMANTLE'],
    selectPositions: actorPosition,
  },
  {
    key: 'DESTROY',
    label: 'Zerstörung',
    order: 50,
    defaultEnabled: false,
    sourceEvents: ['DESTROY'],
    selectPositions: actorPosition,
  },
];

export const RADAR_FUNCTIONS: readonly RadarFunctionDefinition[] = [...catalog].sort((a, b) => a.order - b.order);

export function radarFunctionsForEvent(eventType: AdmEventType): readonly RadarFunctionDefinition[] {
  return RADAR_FUNCTIONS.filter(definition => definition.sourceEvents.includes(eventType));
}

export function radarFunctionByKey(key: string): RadarFunctionDefinition | null {
  return RADAR_FUNCTIONS.find(definition => definition.key === key) ?? null;
}