/**
 * Killfeed V2 (Phase 6) — Ableitung + idempotente Zustellung aus AdmEvents.
 *
 * Trennt Zustellung (KillfeedDelivery, @@unique[configId, admEventId]) von der
 * Anzeige: ein AdmEvent wird pro Config genau einmal gepostet (KILL-001). Der
 * Killer wird IMMER angezeigt, auch ohne Economy-Link (KILL-ECO-001).
 * Koordinaten sind Rohwerte ohne Rundung; Killer/Opfer getrennt, Killer-Coords
 * standardmaessig AUS (KILL-COORD).
 *
 * AdmEvent-Konvention: actor* = Opfer, target* = Killer.
 */

export type KillCategoryV2 = 'DEATH' | 'SUICIDE' | 'NPC' | 'VEHICLE';

export const KILL_EVENT_TYPES = [
  'PLAYER_KILLED', 'PLAYER_DIED', 'PLAYER_SUICIDE', 'NPC_KILL', 'VEHICLE_DEATH',
] as const;

export function mapEventToCategory(eventType: string): KillCategoryV2 | null {
  switch (eventType) {
    case 'PLAYER_KILLED':
    case 'PLAYER_DIED': return 'DEATH';
    case 'PLAYER_SUICIDE': return 'SUICIDE';
    case 'NPC_KILL': return 'NPC';
    case 'VEHICLE_DEATH': return 'VEHICLE';
    default: return null;
  }
}

export interface KillAdmEvent {
  id: string;
  eventType: string;
  occurredAt: Date | null;
  actorGameId: string | null;
  actorName: string | null;
  targetGameId: string | null;
  targetName: string | null;
  toolOrWeapon: string | null;
  distanceMeters: number | null;
  actorPosition: string | null;
  targetPosition: string | null;
}

export interface KillfeedViewConfig {
  showShooterCoords: boolean;
  showVictimCoords: boolean;
  showWeapon: boolean;
  showDistance: boolean;
}

export interface KillfeedView {
  category: KillCategoryV2;
  occurredAt: Date | null;
  victimName: string;
  victimGameId: string | null;
  victimPos: string | null;
  killerName: string | null;
  killerGameId: string | null;
  killerPos: string | null;
  weapon: string | null;
  distanceMeters: number | null;
}

/**
 * Reine Ableitung eines Anzeige-Objekts. Koordinaten roh (keine Rundung), nur
 * gemaess Config-Schaltern; Killer-Coords default AUS. null, wenn der Eventtyp
 * kein Killfeed-Event ist.
 */
export function deriveKillfeedView(ev: KillAdmEvent, cfg: KillfeedViewConfig): KillfeedView | null {
  const category = mapEventToCategory(ev.eventType);
  if (!category) return null;
  return {
    category,
    occurredAt: ev.occurredAt,
    victimName: ev.actorName ?? 'Unbekannt',
    victimGameId: ev.actorGameId,
    victimPos: cfg.showVictimCoords ? ev.actorPosition : null,
    killerName: ev.targetName,
    killerGameId: ev.targetGameId,
    killerPos: cfg.showShooterCoords ? ev.targetPosition : null,
    weapon: cfg.showWeapon ? ev.toolOrWeapon : null,
    distanceMeters: cfg.showDistance ? ev.distanceMeters : null,
  };
}

export interface KillfeedDeliveryClient {
  killfeedDelivery: {
    create: (args: { data: Record<string, unknown> }) => Promise<{ id: string }>;
    update: (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => Promise<unknown>;
  };
}

function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002';
}

/**
 * Beansprucht die Zustellung eines AdmEvents fuer eine Config. Existiert sie
 * bereits, kommt `{ claimed: false }` (bereits zugestellt -> ueberspringen).
 */
export async function claimDelivery(
  client: KillfeedDeliveryClient,
  args: { configId: string; admEventId: string; guildId: string; channelId: string },
): Promise<{ claimed: boolean; id?: string }> {
  try {
    const row = await client.killfeedDelivery.create({
      data: {
        configId: args.configId,
        admEventId: args.admEventId,
        guildId: args.guildId,
        channelId: args.channelId,
      },
    });
    return { claimed: true, id: row.id };
  } catch (e) {
    if (isUniqueViolation(e)) return { claimed: false };
    throw e;
  }
}

export interface KillfeedConfigRow extends KillfeedViewConfig {
  id: string;
  guildId: string;
  nitradoConnId: string;
  channelId: string;
}

export interface DeliverClient extends KillfeedDeliveryClient {
  admEvent: {
    findMany: (args: unknown) => Promise<KillAdmEvent[]>;
  };
}

/**
 * Stellt neue Kill-AdmEvents fuer eine Config zu. `poster` postet die Anzeige
 * und liefert die Discord-Message-ID (oder null). Idempotent: bereits
 * zugestellte Events werden ueber KillfeedDelivery uebersprungen. At-most-once:
 * bei Poster-Fehler bleibt die Zustellung beansprucht (kein Duplikat).
 */
export async function deliverPendingKills(
  client: DeliverClient,
  cfg: KillfeedConfigRow,
  poster: (view: KillfeedView) => Promise<string | null>,
  opts: { limit?: number } = {},
): Promise<{ delivered: number }> {
  const events = await client.admEvent.findMany({
    where: {
      guildId: cfg.guildId,
      nitradoConnId: cfg.nitradoConnId,
      eventType: { in: [...KILL_EVENT_TYPES] },
    },
    orderBy: { occurredAt: 'asc' },
    take: opts.limit ?? 200,
  });

  let delivered = 0;
  for (const ev of events) {
    const view = deriveKillfeedView(ev, cfg);
    if (!view) continue; // kein Kill-Event -> nicht beanspruchen
    const claim = await claimDelivery(client, {
      configId: cfg.id, admEventId: ev.id, guildId: cfg.guildId, channelId: cfg.channelId,
    });
    if (!claim.claimed) continue;
    const messageId = await poster(view);
    if (messageId && claim.id) {
      await client.killfeedDelivery.update({ where: { id: claim.id }, data: { messageId } });
    }
    delivered++;
  }
  return { delivered };
}
