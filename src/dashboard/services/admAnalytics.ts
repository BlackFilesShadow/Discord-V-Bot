/**
 * ADM-Analytics fuer 8 AI-Tools (Spec Sektion 13).
 *
 * Alle Funktionen erhalten ein `AdmParseResult` und liefern aggregierte
 * Daten — sie verwenden ausschliesslich `result.guidEvents` (GUID-strict).
 * Eintraege ohne GUID werden bewusst ignoriert (Spec 13).
 *
 * Tools:
 *   1. killfeed         — Killer-Liste mit K/D, Distanz, Waffe
 *   2. playerTracking   — Spieler-Aktivitaetslinie (connect/disconnect/Events)
 *   3. raidAnalysis     — Base-Raid-Indikatoren (placed/dismantled/built nahe Spieler)
 *   4. baseProximity    — Base-Cluster (Positionen mit hoher Build-Density)
 *   5. movementHeatmap  — Aggregierte X/Y-Hitcells als Heatmap
 *   6. suspiciousActivity — Hohe Distanz-Kills, Headshots-Quote, Zerg-Fights
 *   7. factionActivity  — Akteur-Pairs (Killer/Opfer >= N) -> Konfliktgraph
 *   8. vehicleTracking  — Fahrzeug-Events
 *
 * Saemtliche Funktionen sind reine pure Functions.
 */
import type { AdmEvent, AdmParseResult, AdmActor, AdmCoord } from './admParser';

// --- 1. Killfeed ---------------------------------------------------------

export interface KillfeedEntry {
  killerGuid: string;
  killerName: string;
  victimGuid: string;
  victimName: string;
  weapon?: string;
  distanceM?: number;
  bodyPart?: string;
  ts: string; // ISO
}

export interface KillfeedSummary {
  entries: KillfeedEntry[];
  byKiller: Array<{ guid: string; name: string; kills: number; deaths: number; kd: number; avgDistance: number }>;
}

export function buildKillfeed(p: AdmParseResult): KillfeedSummary {
  const entries: KillfeedEntry[] = [];
  const stats = new Map<string, { name: string; kills: number; deaths: number; distSum: number; distN: number }>();

  for (const e of p.guidEvents) {
    if (e.kind !== 'kill' || !e.target) continue;
    const k = e.actor.guid as string;
    const v = e.target.guid as string;
    entries.push({
      killerGuid: k, killerName: e.actor.name,
      victimGuid: v, victimName: e.target.name,
      weapon: e.weapon, distanceM: e.distanceM, bodyPart: e.bodyPart,
      ts: e.ts.toISOString(),
    });
    const ks = stats.get(k) ?? { name: e.actor.name, kills: 0, deaths: 0, distSum: 0, distN: 0 };
    ks.kills++;
    if (e.distanceM != null) { ks.distSum += e.distanceM; ks.distN++; }
    stats.set(k, ks);
    const vs = stats.get(v) ?? { name: e.target.name, kills: 0, deaths: 0, distSum: 0, distN: 0 };
    vs.deaths++;
    stats.set(v, vs);
  }

  const byKiller = Array.from(stats.entries()).map(([guid, s]) => ({
    guid,
    name: s.name,
    kills: s.kills,
    deaths: s.deaths,
    kd: s.deaths === 0 ? s.kills : +(s.kills / s.deaths).toFixed(2),
    avgDistance: s.distN === 0 ? 0 : +(s.distSum / s.distN).toFixed(1),
  })).sort((a, b) => b.kills - a.kills);

  return { entries: entries.slice(0, 1000), byKiller };
}

// --- 2. PlayerTracking ----------------------------------------------------

export interface PlayerSession {
  guid: string;
  name: string;
  connectAt: string;
  disconnectAt?: string;
  durationMin?: number;
  eventCount: number;
}

export function buildPlayerTracking(p: AdmParseResult): PlayerSession[] {
  const open = new Map<string, { name: string; connectAt: Date; eventCount: number }>();
  const out: PlayerSession[] = [];

  for (const e of p.guidEvents) {
    const g = e.actor.guid as string;
    if (e.kind === 'connect') {
      open.set(g, { name: e.actor.name, connectAt: e.ts, eventCount: 0 });
    } else if (e.kind === 'disconnect') {
      const o = open.get(g);
      if (o) {
        out.push({
          guid: g, name: o.name,
          connectAt: o.connectAt.toISOString(),
          disconnectAt: e.ts.toISOString(),
          durationMin: +((e.ts.getTime() - o.connectAt.getTime()) / 60000).toFixed(1),
          eventCount: o.eventCount,
        });
        open.delete(g);
      }
    } else {
      const o = open.get(g);
      if (o) o.eventCount++;
    }
  }
  // noch offene Sessions
  for (const [g, o] of open) {
    out.push({
      guid: g, name: o.name,
      connectAt: o.connectAt.toISOString(),
      eventCount: o.eventCount,
    });
  }
  return out.sort((a, b) => (b.durationMin ?? 0) - (a.durationMin ?? 0)).slice(0, 500);
}

// --- 3. RaidAnalysis ------------------------------------------------------

export interface RaidIndicator {
  ts: string;
  guid: string;
  name: string;
  action: 'placed' | 'built' | 'dismantled';
  item?: string;
  pos: AdmCoord | null;
}

export function buildRaidAnalysis(p: AdmParseResult, windowMin = 30): { indicators: RaidIndicator[]; clusters: number } {
  const ind: RaidIndicator[] = [];
  for (const e of p.guidEvents) {
    if (e.kind === 'placed' || e.kind === 'built' || e.kind === 'dismantled') {
      ind.push({
        ts: e.ts.toISOString(),
        guid: e.actor.guid as string,
        name: e.actor.name,
        action: e.kind,
        item: e.itemOrText,
        pos: e.actor.pos,
      });
    }
  }
  // simples Clustering nach Zeit-Bucket
  const buckets = new Set<string>();
  for (const x of ind) {
    const t = new Date(x.ts).getTime();
    const bucket = Math.floor(t / (windowMin * 60_000));
    if (x.pos) buckets.add(`${bucket}|${Math.floor(x.pos.x / 50)}|${Math.floor(x.pos.y / 50)}`);
  }
  return { indicators: ind.slice(0, 500), clusters: buckets.size };
}

// --- 4. BaseProximity -----------------------------------------------------

export interface BaseCluster {
  centerX: number;
  centerY: number;
  buildEvents: number;
  participants: string[]; // GUIDs
}

export function buildBaseProximity(p: AdmParseResult, cellSize = 100): BaseCluster[] {
  const cells = new Map<string, { x: number; y: number; n: number; guids: Set<string> }>();
  for (const e of p.guidEvents) {
    if (!e.actor.pos) continue;
    if (e.kind !== 'placed' && e.kind !== 'built') continue;
    const cx = Math.floor(e.actor.pos.x / cellSize);
    const cy = Math.floor(e.actor.pos.y / cellSize);
    const key = `${cx}|${cy}`;
    const c = cells.get(key) ?? { x: cx * cellSize + cellSize / 2, y: cy * cellSize + cellSize / 2, n: 0, guids: new Set<string>() };
    c.n++;
    c.guids.add(e.actor.guid as string);
    cells.set(key, c);
  }
  return Array.from(cells.values())
    .filter(c => c.n >= 3)
    .map(c => ({ centerX: c.x, centerY: c.y, buildEvents: c.n, participants: Array.from(c.guids) }))
    .sort((a, b) => b.buildEvents - a.buildEvents)
    .slice(0, 100);
}

// --- 5. MovementHeatmap ---------------------------------------------------

export interface HeatmapCell { x: number; y: number; weight: number }

export function buildMovementHeatmap(p: AdmParseResult, cellSize = 100): HeatmapCell[] {
  const cells = new Map<string, HeatmapCell>();
  for (const e of p.guidEvents) {
    const positions: Array<AdmCoord | null | undefined> = [e.actor.pos, e.target?.pos];
    for (const pos of positions) {
      if (!pos) continue;
      const cx = Math.floor(pos.x / cellSize);
      const cy = Math.floor(pos.y / cellSize);
      const key = `${cx}|${cy}`;
      const c = cells.get(key) ?? { x: cx * cellSize + cellSize / 2, y: cy * cellSize + cellSize / 2, weight: 0 };
      c.weight++;
      cells.set(key, c);
    }
  }
  return Array.from(cells.values()).sort((a, b) => b.weight - a.weight).slice(0, 2000);
}

// --- 6. SuspiciousActivity ------------------------------------------------

export interface SuspiciousFinding {
  ts: string;
  guid: string;
  name: string;
  reason: string;
  details: Record<string, unknown>;
}

const HEADSHOT_PARTS = new Set(['head', 'brain', 'skull']);
const LONG_DISTANCE_M = 400;

export function buildSuspiciousActivity(p: AdmParseResult): SuspiciousFinding[] {
  const findings: SuspiciousFinding[] = [];
  const headshotByKiller = new Map<string, { name: string; total: number; head: number }>();

  for (const e of p.guidEvents) {
    if (e.kind !== 'kill') continue;
    const g = e.actor.guid as string;
    const s = headshotByKiller.get(g) ?? { name: e.actor.name, total: 0, head: 0 };
    s.total++;
    if (e.bodyPart && HEADSHOT_PARTS.has(e.bodyPart.toLowerCase())) s.head++;
    headshotByKiller.set(g, s);

    if (e.distanceM != null && e.distanceM >= LONG_DISTANCE_M) {
      findings.push({
        ts: e.ts.toISOString(),
        guid: g, name: e.actor.name,
        reason: 'long_distance_kill',
        details: { distanceM: e.distanceM, weapon: e.weapon, victim: e.target?.name },
      });
    }
  }
  for (const [g, s] of headshotByKiller) {
    if (s.total >= 5 && s.head / s.total >= 0.7) {
      findings.push({
        ts: new Date().toISOString(),
        guid: g, name: s.name,
        reason: 'high_headshot_ratio',
        details: { ratio: +(s.head / s.total).toFixed(2), kills: s.total },
      });
    }
  }
  return findings.sort((a, b) => a.ts.localeCompare(b.ts)).slice(0, 500);
}

// --- 7. FactionActivity ---------------------------------------------------

export interface ConflictEdge {
  aGuid: string; aName: string;
  bGuid: string; bName: string;
  encounters: number;
}

export function buildFactionActivity(p: AdmParseResult, minEncounters = 2): ConflictEdge[] {
  const pairs = new Map<string, ConflictEdge>();
  for (const e of p.guidEvents) {
    if ((e.kind !== 'kill' && e.kind !== 'hit') || !e.target) continue;
    const a = e.actor as Required<AdmActor> & { guid: string };
    const b = e.target as Required<AdmActor> & { guid: string };
    const [k1, k2] = [a.guid, b.guid].sort();
    const key = `${k1}|${k2}`;
    const cur = pairs.get(key) ?? {
      aGuid: k1, aName: k1 === a.guid ? a.name : b.name,
      bGuid: k2, bName: k2 === a.guid ? a.name : b.name,
      encounters: 0,
    };
    cur.encounters++;
    pairs.set(key, cur);
  }
  return Array.from(pairs.values())
    .filter(x => x.encounters >= minEncounters)
    .sort((a, b) => b.encounters - a.encounters)
    .slice(0, 200);
}

// --- 8. VehicleTracking ---------------------------------------------------

export interface VehicleEvent {
  ts: string;
  guid: string;
  name: string;
  vehicle?: string;
  raw: string;
}

export function buildVehicleTracking(p: AdmParseResult): VehicleEvent[] {
  return p.guidEvents
    .filter(e => e.kind === 'vehicle')
    .map(e => ({
      ts: e.ts.toISOString(),
      guid: e.actor.guid as string,
      name: e.actor.name,
      vehicle: e.vehicle,
      raw: e.raw.slice(0, 300),
    }))
    .slice(0, 500);
}

// Convenience: alle 8 in einem Aufruf.
export function buildAllAnalytics(p: AdmParseResult): {
  killfeed: KillfeedSummary;
  playerTracking: PlayerSession[];
  raid: { indicators: RaidIndicator[]; clusters: number };
  baseProximity: BaseCluster[];
  heatmap: HeatmapCell[];
  suspicious: SuspiciousFinding[];
  factions: ConflictEdge[];
  vehicles: VehicleEvent[];
  meta: { totalEvents: number; guidEvents: number; ignoredNoGuid: number; startedAt: string | null };
} {
  return {
    killfeed: buildKillfeed(p),
    playerTracking: buildPlayerTracking(p),
    raid: buildRaidAnalysis(p),
    baseProximity: buildBaseProximity(p),
    heatmap: buildMovementHeatmap(p),
    suspicious: buildSuspiciousActivity(p),
    factions: buildFactionActivity(p),
    vehicles: buildVehicleTracking(p),
    meta: {
      totalEvents: p.events.length,
      guidEvents: p.guidEvents.length,
      ignoredNoGuid: p.unknownPlayerEvents,
      startedAt: p.startedAt ? p.startedAt.toISOString() : null,
    },
  };
}

// Re-export Typen fuer die Routen-Datei.
export type { AdmEvent, AdmParseResult, AdmActor, AdmCoord };
