export type DeathFeedCategory = 'PVP' | 'SUICIDE' | 'NPC' | 'VEHICLE';
export type BuildFeedCategory = 'BUILD' | 'DISMANTLE' | 'DESTROY';
export type PlacementFeedCategory = 'PLACEMENT';
export type FlagFeedCategory = 'RAISED' | 'LOWERED';
export type GameplayFeedCategory = DeathFeedCategory | BuildFeedCategory | PlacementFeedCategory | FlagFeedCategory;
export type GameplayFeedKindValue = 'DEATH' | 'BUILD' | 'PLACEMENT' | 'PLAYER_LIST' | 'FLAG';

export const DEATH_CATEGORIES: readonly DeathFeedCategory[] = ['PVP', 'SUICIDE', 'NPC', 'VEHICLE'];
export const BUILD_CATEGORIES: readonly BuildFeedCategory[] = ['BUILD', 'DISMANTLE', 'DESTROY'];
export const PLACEMENT_CATEGORIES: readonly PlacementFeedCategory[] = ['PLACEMENT'];
export const FLAG_CATEGORIES: readonly FlagFeedCategory[] = ['RAISED', 'LOWERED'];

// PLAYER_DIED bleibt als kanonisches ADM-Rohereignis erhalten, wird aber bewusst
// nicht mehr als Gameplay-Feed zugestellt. Der generische "died / bled out"-Feed
// liefert auf Konsole keine belastbare, einheitliche Ursache fuer ein eigenes Embed.
export const DEATH_EVENT_TYPES = [
  'PLAYER_KILLED',
  'PLAYER_SUICIDE',
  'NPC_KILL',
  'VEHICLE_DEATH',
] as const;

// Gemeinsamer DB-Scan-Superset fuer die zwei strikt getrennten semantischen
// Feed-Klassen BUILD und PLACEMENT. categoryAllowed() verhindert jede
// Cross-Delivery; damit kann die bestehende Runtime ohne historische Luecken
// beide Typen ueber denselben ADM-Scan-Mechanismus verarbeiten.
export const BUILD_EVENT_TYPES = ['PLACEMENT', 'BUILD', 'DISMANTLE', 'DESTROY'] as const;
export const FLAG_EVENT_TYPES = ['FLAG_RAISED', 'FLAG_LOWERED'] as const;

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
  /**
   * Expliziter Anzeigezustand fuer Waffe/Werkzeug. Optional, damit bereits
   * bestehende direkte View-Aufrufer ohne Toggle weiterhin ihr bisheriges
   * Renderverhalten behalten; die produktive Runtime setzt den Wert immer.
   */
  showTool?: boolean;
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
    case 'PLAYER_SUICIDE': return 'SUICIDE';
    case 'NPC_KILL': return 'NPC';
    case 'VEHICLE_DEATH': return 'VEHICLE';
    case 'PLACEMENT': return 'PLACEMENT';
    case 'BUILD': return 'BUILD';
    case 'DISMANTLE': return 'DISMANTLE';
    case 'DESTROY': return 'DESTROY';
    case 'FLAG_RAISED': return 'RAISED';
    case 'FLAG_LOWERED': return 'LOWERED';
    default: return null;
  }
}

export function kindForEvent(eventType: string): GameplayFeedKindValue | null {
  if ((DEATH_EVENT_TYPES as readonly string[]).includes(eventType)) return 'DEATH';
  if (eventType === 'PLACEMENT') return 'PLACEMENT';
  if (eventType === 'BUILD' || eventType === 'DISMANTLE' || eventType === 'DESTROY') return 'BUILD';
  if ((FLAG_EVENT_TYPES as readonly string[]).includes(eventType)) return 'FLAG';
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
    showTool: toggles.showTool,
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
