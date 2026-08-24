export type DeathFeedCategory = 'PVP' | 'DEATH' | 'SUICIDE' | 'NPC' | 'VEHICLE';
export type BuildFeedCategory = 'PLACEMENT' | 'BUILD' | 'DISMANTLE' | 'DESTROY';
export type GameplayFeedCategory = DeathFeedCategory | BuildFeedCategory;
export type GameplayFeedKindValue = 'DEATH' | 'BUILD' | 'PLAYER_LIST';

export const DEATH_CATEGORIES: readonly DeathFeedCategory[] = ['PVP', 'DEATH', 'SUICIDE', 'NPC', 'VEHICLE'];
export const BUILD_CATEGORIES: readonly BuildFeedCategory[] = ['PLACEMENT', 'BUILD', 'DISMANTLE', 'DESTROY'];

export const DEATH_EVENT_TYPES = [
  'PLAYER_KILLED',
  'PLAYER_DIED',
  'PLAYER_SUICIDE',
  'NPC_KILL',
  'VEHICLE_DEATH',
] as const;

export const BUILD_EVENT_TYPES = ['PLACEMENT', 'BUILD', 'DISMANTLE', 'DESTROY'] as const;

export interface GameplayAdmEvent {
  id: string;
  eventType: string;
  occurredAt: Date | null;
  createdAt: Date;
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

export interface GameplayFeedView {
  eventId: string;
  kind: GameplayFeedKindValue;
  category: GameplayFeedCategory;
  eventType: string;
  occurredAt: Date | null;
  actorName: string;
  targetName: string | null;
  objectType: string | null;
  toolOrWeapon: string | null;
  distanceMeters: number | null;
  actorPosition: string | null;
  targetPosition: string | null;
}

export interface GameplayDisplayToggles {
  showActorCoords: boolean;
  showTargetCoords: boolean;
  showTool: boolean;
  showDistance: boolean;
}

export function categoryForEvent(eventType: string): GameplayFeedCategory | null {
  switch (eventType) {
    case 'PLAYER_KILLED': return 'PVP';
    case 'PLAYER_DIED': return 'DEATH';
    case 'PLAYER_SUICIDE': return 'SUICIDE';
    case 'NPC_KILL': return 'NPC';
    case 'VEHICLE_DEATH': return 'VEHICLE';
    case 'PLACEMENT': return 'PLACEMENT';
    case 'BUILD': return 'BUILD';
    case 'DISMANTLE': return 'DISMANTLE';
    case 'DESTROY': return 'DESTROY';
    default: return null;
  }
}

export function kindForEvent(eventType: string): GameplayFeedKindValue | null {
  if ((DEATH_EVENT_TYPES as readonly string[]).includes(eventType)) return 'DEATH';
  if ((BUILD_EVENT_TYPES as readonly string[]).includes(eventType)) return 'BUILD';
  return null;
}

export function deriveGameplayFeedView(
  event: GameplayAdmEvent,
  toggles: GameplayDisplayToggles,
): GameplayFeedView | null {
  const category = categoryForEvent(event.eventType);
  const kind = kindForEvent(event.eventType);
  if (!category || !kind) return null;
  return {
    eventId: event.id,
    kind,
    category,
    eventType: event.eventType,
    occurredAt: event.occurredAt,
    actorName: event.actorName?.trim() || 'Unbekannt',
    targetName: event.targetName?.trim() || null,
    objectType: event.objectType?.trim() || null,
    toolOrWeapon: toggles.showTool ? event.toolOrWeapon?.trim() || null : null,
    distanceMeters: toggles.showDistance ? event.distanceMeters : null,
    actorPosition: toggles.showActorCoords ? event.actorPosition : null,
    targetPosition: toggles.showTargetCoords ? event.targetPosition : null,
  };
}

export function categoryAllowed(kind: GameplayFeedKindValue, categories: readonly string[], eventType: string): boolean {
  if (kind === 'PLAYER_LIST') return false;
  if (kindForEvent(eventType) !== kind) return false;
  const category = categoryForEvent(eventType);
  return category !== null && categories.includes(category);
}
