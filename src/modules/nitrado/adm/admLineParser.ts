/**
 * Kanonischer DayZ-ADM-Zeilenparser (Phase 3, parserVersion 1).
 *
 * Ziel: dieselbe normalisierte Ereignisstruktur fuer ALLE Verbraucher
 * (Killfeed, Economy-Rewards, Online-Liste, Analytics). Unbekannte Zeilen
 * werden als UNKNOWN markiert — niemals geraten. Fehlt der Basis-Datumskontext,
 * bleibt occurredAt null (parseStatus UNRESOLVED_TIMESTAMP) statt still `heute`
 * einzusetzen (ADM-007).
 *
 * Unterstuetzte dokumentierte Varianten (bewusst tolerant ggü. Whitespace,
 * optionalem "Player"-Praefix, optionalem "(DEAD)", Steam64/DAYZ-GUID):
 *   - "... Player "Name"(id=GUID) is connected" / "...) connected"
 *   - "... Player "Name"(id=GUID) has been disconnected" / "...) disconnected"
 *   - "... Player "Victim"(DEAD)(id=..,pos=<..>) killed by Player "Killer"(..) with W from N meters"
 *   - "... Player "Victim"(id=..) killed by "Killer"(..)"  (ohne (DEAD)/Player)
 *   - "... killed by <Tier/Infected>"  -> NPC
 *   - "... committed suicide" / "... bled out" / "... died"
 *   - "... hit by [vehicle] X" / "... at speed N km/h"
 *   - "... placed <Objekt>"
 *   - "... built|dismantled|destroyed <Objekt>"
 *   - PlayerList-Positionszeile "Player "Name"(id=..) pos=<..>"
 */

export const ADM_PARSER_VERSION = 1;

export type AdmParsedType =
  | 'PLAYER_CONNECTED'
  | 'PLAYER_DISCONNECTED'
  | 'PLAYER_KILLED'
  | 'PLAYER_SUICIDE'
  | 'PLAYER_DIED'
  | 'NPC_KILL'
  | 'VEHICLE_DEATH'
  | 'PLAYER_HIT'
  | 'PLACEMENT'
  | 'BUILD'
  | 'DISMANTLE'
  | 'DESTROY'
  | 'PLAYER_POSITION'
  | 'UNKNOWN';

export type AdmParseStatus = 'OK' | 'UNKNOWN' | 'UNRESOLVED_TIMESTAMP';

export interface ParsedAdmEvent {
  eventType: AdmParsedType;
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
  rawLine: string;
  parseStatus: AdmParseStatus;
}

export interface AdmDateContext {
  baseDate: Date | null;
  dayOffsetMs: number;
  prevTimeMs: number;
}

const HEADER_DATE_RE = /AdminLog started on (\d{4})-(\d{2})-(\d{2})/;
const TIME_RE = /^(\d{2}):(\d{2}):(\d{2})/;
const NAME_RE = /"([^"]+)"/;
const ID_RE = /id=([^\s,)]+)/;
const POS_RE = /pos=<([^>]+)>/;
const WEAPON_RE = /\bwith\s+(.+?)(?:\s+from\s+[\d.]+\s*m(?:eters?)?)?\s*$/i;
const DISTANCE_RE = /\bfrom\s+([\d.]+)\s*m(?:eters?)?\b/i;

/** Basisdatum aus Header ("AdminLog started on YYYY-MM-DD") oder Dateiname. Sonst null. */
export function resolveBaseDate(text: string, fileName?: string): Date | null {
  for (const line of text.split(/\r?\n/, 8)) {
    const m = HEADER_DATE_RE.exec(line);
    if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  }
  if (fileName) {
    const fm = /(\d{4})-(\d{2})-(\d{2})/.exec(fileName);
    if (fm) return new Date(Date.UTC(+fm[1], +fm[2] - 1, +fm[3]));
  }
  return null;
}

export function newDateContext(baseDate: Date | null): AdmDateContext {
  return { baseDate, dayOffsetMs: 0, prevTimeMs: -1 };
}

function emptyEvent(rawLine: string, eventType: AdmParsedType, occurredAt: Date | null, status: AdmParseStatus): ParsedAdmEvent {
  return {
    eventType, occurredAt,
    actorGameId: null, actorName: null, targetGameId: null, targetName: null,
    objectType: null, toolOrWeapon: null, distanceMeters: null,
    actorPosition: null, targetPosition: null,
    rawLine, parseStatus: status,
  };
}

function extractActor(seg: string): { name: string | null; id: string | null; pos: string | null } {
  return {
    name: NAME_RE.exec(seg)?.[1] ?? null,
    id: ID_RE.exec(seg)?.[1] ?? null,
    pos: POS_RE.exec(seg)?.[1] ?? null,
  };
}

/**
 * Parst eine einzelne ADM-Zeile. Aktualisiert den Datumskontext (Header/
 * Tageswechsel). Liefert null fuer Nicht-Ereigniszeilen (leer, Header,
 * ohne Zeitstempel).
 */
export function parseAdmLine(line: string, ctx: AdmDateContext): ParsedAdmEvent | null {
  const header = HEADER_DATE_RE.exec(line);
  if (header) {
    ctx.baseDate = new Date(Date.UTC(+header[1], +header[2] - 1, +header[3]));
    return null;
  }
  const tm = TIME_RE.exec(line);
  if (!tm) return null;

  const timeMs = (+tm[1] * 3600 + +tm[2] * 60 + +tm[3]) * 1000;
  if (ctx.prevTimeMs >= 0 && timeMs < ctx.prevTimeMs - 60_000) ctx.dayOffsetMs += 86_400_000;
  ctx.prevTimeMs = timeMs;
  const occurredAt = ctx.baseDate ? new Date(ctx.baseDate.getTime() + ctx.dayOffsetMs + timeMs) : null;
  const status: AdmParseStatus = ctx.baseDate ? 'OK' : 'UNRESOLVED_TIMESTAMP';

  // Inhalt nach "HH:MM:SS |" bzw. "HH:MM:SS"
  const content = line.replace(/^\d{2}:\d{2}:\d{2}\s*\|?\s*/, '');
  const hasPlayer = /Player\s*"/.test(content) || /"[^"]+"\s*\(/.test(content);

  const finalize = (ev: ParsedAdmEvent): ParsedAdmEvent => {
    ev.occurredAt = occurredAt;
    if (ev.parseStatus === 'OK') ev.parseStatus = status;
    return ev;
  };

  // 1) Connect / Disconnect
  if (/\bis connected\b/.test(content) || /\)\s*connected\b/.test(content)) {
    const a = extractActor(content);
    return finalize(fill(content, 'PLAYER_CONNECTED', a));
  }
  if (/\bhas been disconnected\b/.test(content) || /\)\s*disconnected\b/.test(content)) {
    const a = extractActor(content);
    return finalize(fill(content, 'PLAYER_DISCONNECTED', a));
  }

  // 2) Toedliche Ereignisse
  if (/committed suicide/i.test(content)) {
    return finalize(fill(content, 'PLAYER_SUICIDE', extractActor(content)));
  }
  const killedByIdx = content.search(/killed by/i);
  if (killedByIdx >= 0) {
    const victimSeg = content.slice(0, killedByIdx);
    const killerSeg = content.slice(killedByIdx + 'killed by'.length);
    const victim = extractActor(victimSeg);
    const isVehicle = /\[vehicle\]|at speed\s+\d+\s*km\/h/i.test(content);
    const killerIsPlayer = /Player\s*"|"[^"]+"\s*\(id=/i.test(killerSeg);
    const ev = emptyEvent(content, 'UNKNOWN', null, 'OK');
    ev.actorName = victim.name; ev.actorGameId = victim.id; ev.actorPosition = victim.pos;
    if (isVehicle) {
      ev.eventType = 'VEHICLE_DEATH';
    } else if (killerIsPlayer) {
      ev.eventType = 'PLAYER_KILLED';
      const killer = extractActor(killerSeg);
      ev.targetName = killer.name; ev.targetGameId = killer.id; ev.targetPosition = killer.pos;
      ev.toolOrWeapon = WEAPON_RE.exec(killerSeg)?.[1]?.trim() ?? null;
      const dm = DISTANCE_RE.exec(killerSeg);
      ev.distanceMeters = dm ? Number(dm[1]) : null;
    } else {
      ev.eventType = 'NPC_KILL';
      ev.targetName = killerSeg.trim().replace(/[.\s]+$/, '') || null; // Tier/Infected-Name
    }
    return finalize(ev);
  }
  if (/\bbled out\b|\bdied\b/i.test(content)) {
    return finalize(fill(content, 'PLAYER_DIED', extractActor(content)));
  }
  if (/\bhit by\b/i.test(content)) {
    const isVehicle = /\[vehicle\]|at speed\s+\d+\s*km\/h/i.test(content);
    return finalize(fill(content, isVehicle ? 'VEHICLE_DEATH' : 'PLAYER_HIT', extractActor(content)));
  }

  // 3) Bau / Platzierung
  const placed = /\bplaced\s+(.+?)\s*$/i.exec(content);
  if (placed) {
    const ev = fill(content, 'PLACEMENT', extractActor(content));
    ev.objectType = cleanObject(placed[1]);
    return finalize(ev);
  }
  const built = /\bbuilt\s+(.+?)\s*$/i.exec(content);
  if (built) {
    const ev = fill(content, 'BUILD', extractActor(content));
    ev.objectType = cleanObject(built[1]);
    return finalize(ev);
  }
  const dismantled = /\bdismantled\s+(.+?)\s*$/i.exec(content);
  if (dismantled) {
    const ev = fill(content, 'DISMANTLE', extractActor(content));
    ev.objectType = cleanObject(dismantled[1]);
    return finalize(ev);
  }
  const destroyed = /\bdestroyed\s+(.+?)\s*$/i.exec(content);
  if (destroyed) {
    const ev = fill(content, 'DESTROY', extractActor(content));
    ev.objectType = cleanObject(destroyed[1]);
    return finalize(ev);
  }

  // 4) Reine Positionszeile (PlayerList): Player-Token + pos, keine Aktion
  if (hasPlayer && POS_RE.test(content) && isBarePlayerPosition(content)) {
    return finalize(fill(content, 'PLAYER_POSITION', extractActor(content)));
  }

  // 5) Zeitstempel-Zeile mit Spielerbezug, aber unbekanntes Format
  if (hasPlayer) {
    return finalize(emptyEvent(content, 'UNKNOWN', null, 'UNKNOWN'));
  }
  return null;
}

function fill(content: string, type: AdmParsedType, a: { name: string | null; id: string | null; pos: string | null }): ParsedAdmEvent {
  const ev = emptyEvent(content, type, null, 'OK');
  ev.actorName = a.name;
  ev.actorGameId = a.id;
  ev.actorPosition = a.pos;
  return ev;
}

function cleanObject(s: string): string {
  return s.replace(/\s*\(id=[^)]*\)\s*$/i, '').replace(/\s*pos=<[^>]*>\s*$/i, '').trim();
}

/** Heuristik: Zeile besteht im Wesentlichen nur aus Player-Token + Position. */
function isBarePlayerPosition(content: string): boolean {
  const stripped = content
    .replace(/Player\s*/i, '')
    .replace(/"[^"]+"/, '')
    .replace(/\(id=[^)]*\)/i, '')
    .replace(/pos=<[^>]*>/i, '')
    .replace(/[(),\s]/g, '');
  return stripped.length === 0;
}
