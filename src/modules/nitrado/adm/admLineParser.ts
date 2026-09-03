/**
 * Kanonischer DayZ-ADM-Zeilenparser.
 *
 * Ein Ereignis wird nur so spezifisch klassifiziert, wie es die ADM-Zeile
 * tatsaechlich belegt. ADM-Uhrzeiten sind Wanduhrzeiten des Servers; wenn eine
 * IANA-Zeitzone konfiguriert ist, werden sie DST-sicher nach UTC aufgeloest.
 */

export const ADM_PARSER_VERSION = 5;

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
  | 'FLAG_RAISED'
  | 'FLAG_LOWERED'
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
  timeZone: string | null;
}

export interface PvpHitDetails {
  bodyPart: string;
  damage: number;
  damageType: string;
  weapon: string | null;
}

const HEADER_DATE_RE = /AdminLog started on (\d{4})-(\d{2})-(\d{2})/;
const TIME_RE = /^(\d{2}):(\d{2}):(\d{2})/;
const NAME_RE = /"([^"]+)"/;
const ID_RE = /id=([^\s,)]+)/;
const POS_RE = /pos=<([^>]+)>/;
const DISTANCE_RE = /\bfrom\s+([\d.]+)\s*m(?:eters?)?\b/i;
const PVP_HIT_DETAILS_RE = /\bhit by\s+(.+?)\s+into\s+([A-Za-z]+)\(\d+\)\s+for\s+([\d.]+)\s+damage\s+\(([^)]+)\)(?:\s+with\s+(.+?))?\s*\.?\s*$/i;
const FLAG_ACTION_RE = /^Player\s+"([^"]+)"\s*\(id=([^\s,)]+)\s+pos=<([^>]+)>\)\s+has\s+(raised|lowered)\s+(.+?)\s+on\s+TerritoryFlag\s+at\s+<([^>]+)>\s*\.?\s*$/i;
const COORDINATE_TRIPLET_RE = /^\s*[+-]?(?:\d+(?:\.\d+)?|\.\d+)\s*,\s*[+-]?(?:\d+(?:\.\d+)?|\.\d+)\s*,\s*[+-]?(?:\d+(?:\.\d+)?|\.\d+)\s*$/;

export function resolveBaseDate(text: string, fileName?: string): Date | null {
  for (const line of text.split(/\r?\n/, 8)) {
    const match = HEADER_DATE_RE.exec(line);
    if (match) return new Date(Date.UTC(+match[1], +match[2] - 1, +match[3]));
  }
  if (fileName) {
    const match = /(\d{4})-(\d{2})-(\d{2})/.exec(fileName);
    if (match) return new Date(Date.UTC(+match[1], +match[2] - 1, +match[3]));
  }
  return null;
}

export function newDateContext(baseDate: Date | null, timeZone: string | null = null): AdmDateContext {
  return { baseDate, dayOffsetMs: 0, prevTimeMs: -1, timeZone };
}

function wallClockToUtc(
  dateAnchor: Date,
  dayOffsetMs: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string | null,
): Date {
  const day = new Date(dateAnchor.getTime() + dayOffsetMs);
  const year = day.getUTCFullYear();
  const month = day.getUTCMonth();
  const date = day.getUTCDate();
  const targetWallAsUtc = Date.UTC(year, month, date, hour, minute, second);
  if (!timeZone) return new Date(targetWallAsUtc);

  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });

  let guess = targetWallAsUtc;
  for (let pass = 0; pass < 3; pass++) {
    const parts = formatter.formatToParts(new Date(guess));
    const value = (type: Intl.DateTimeFormatPartTypes): number =>
      Number(parts.find(part => part.type === type)?.value ?? 0);
    const representedWallAsUtc = Date.UTC(
      value('year'),
      value('month') - 1,
      value('day'),
      value('hour'),
      value('minute'),
      value('second'),
    );
    const delta = targetWallAsUtc - representedWallAsUtc;
    guess += delta;
    if (delta === 0) break;
  }
  return new Date(guess);
}

function emptyEvent(rawLine: string, eventType: AdmParsedType, status: AdmParseStatus): ParsedAdmEvent {
  return {
    eventType,
    occurredAt: null,
    actorGameId: null,
    actorName: null,
    targetGameId: null,
    targetName: null,
    objectType: null,
    toolOrWeapon: null,
    distanceMeters: null,
    actorPosition: null,
    targetPosition: null,
    rawLine,
    parseStatus: status,
  };
}

function extractActor(segment: string): { name: string | null; id: string | null; pos: string | null } {
  return {
    name: NAME_RE.exec(segment)?.[1] ?? null,
    id: ID_RE.exec(segment)?.[1] ?? null,
    pos: POS_RE.exec(segment)?.[1]?.trim() ?? null,
  };
}

function fill(
  content: string,
  type: AdmParsedType,
  actor: { name: string | null; id: string | null; pos: string | null },
): ParsedAdmEvent {
  const event = emptyEvent(content, type, 'OK');
  event.actorName = actor.name;
  event.actorGameId = actor.id;
  event.actorPosition = actor.pos;
  return event;
}

function cleanActionValue(value: string): string {
  return value
    .replace(/\s*\(id=[^)]*\)\s*$/i, '')
    .replace(/\s*pos=<[^>]*>\s*$/i, '')
    .replace(/[.\s]+$/, '')
    .trim();
}

function parseBuildAction(content: string): { type: AdmParsedType; object: string; tool: string | null } | null {
  const match = /\b(placed|built|dismantled|destroyed)\s+(.+?)\s*$/i.exec(content);
  if (!match) return null;
  const action = match[1].toLowerCase();
  const tail = match[2].trim();
  const withMatch = /^(.+?)\s+with\s+(.+?)\s*$/i.exec(tail);
  const object = cleanActionValue(withMatch?.[1] ?? tail);
  const tool = withMatch ? cleanActionValue(withMatch[2]) : null;
  const type: AdmParsedType = action === 'placed'
    ? 'PLACEMENT'
    : action === 'built'
      ? 'BUILD'
      : action === 'dismantled'
        ? 'DISMANTLE'
        : 'DESTROY';
  return object ? { type, object, tool } : null;
}

function parseFlagAction(content: string): ParsedAdmEvent | null {
  // TerritoryFlag actions are accepted only in the canonical DayZ player-action
  // shape. Chat/report text can contain the same English words and must never
  // become a gameplay event merely because an unanchored substring matches.
  const match = FLAG_ACTION_RE.exec(content);
  if (!match) return null;
  const actorPosition = match[3].trim();
  const flagPosition = match[6].trim();
  if (!COORDINATE_TRIPLET_RE.test(actorPosition) || !COORDINATE_TRIPLET_RE.test(flagPosition)) return null;
  const objectType = cleanActionValue(match[5]);
  if (!objectType || /[\r\n\t\u0000-\u001f\u007f]/.test(objectType)) return null;

  const event = fill(content, match[4].toLowerCase() === 'raised' ? 'FLAG_RAISED' : 'FLAG_LOWERED', {
    name: match[1],
    id: match[2],
    pos: actorPosition,
  });
  event.objectType = objectType;
  event.targetName = 'TerritoryFlag';
  event.targetPosition = flagPosition;
  return event;
}

function extractWeapon(segment: string): string | null {
  const withIndex = segment.search(/\bwith\s+/i);
  if (withIndex < 0) return null;
  let weapon = segment.slice(withIndex).replace(/^.*?\bwith\s+/i, '');
  weapon = weapon.replace(/\s+from\s+[\d.]+\s*m(?:eters?)?\s*$/i, '');
  weapon = weapon.trim().replace(/[.\s]+$/, '');
  return weapon || null;
}

function extractVehicleCause(segment: string): string | null {
  let cause = segment;
  const hitBy = cause.search(/\bhit by\b/i);
  if (hitBy >= 0) cause = cause.slice(hitBy + 'hit by'.length);
  const killedBy = cause.search(/\bkilled by\b/i);
  if (killedBy >= 0) cause = cause.slice(killedBy + 'killed by'.length);
  cause = cause
    .replace(/^\s*\[vehicle\]\s*/i, '')
    .replace(/\s+at speed\s+\d+(?:\.\d+)?\s*km\/h.*$/i, '')
    .replace(/[.\s]+$/, '')
    .trim();
  return cause || null;
}

/** Liest nur Werte aus einem vollstaendigen, von ADM bezeugten PvP-Treffer. */
export function parsePvpHitDetails(rawLine: string): PvpHitDetails | null {
  const match = PVP_HIT_DETAILS_RE.exec(rawLine);
  if (!match) return null;
  const damage = Number(match[3]);
  if (!Number.isFinite(damage)) return null;
  const weapon = match[5]?.trim().replace(/[.\s]+$/, '') || null;
  return {
    bodyPart: match[2],
    damage,
    damageType: match[4].trim(),
    weapon,
  };
}

function isBarePlayerPosition(content: string): boolean {
  const stripped = content
    .replace(/Player\s*/i, '')
    .replace(/"[^"]+"/, '')
    .replace(/\(id=[^)]*\)/i, '')
    .replace(/pos=<[^>]*>/i, '')
    .replace(/[(),\s]/g, '');
  return stripped.length === 0;
}

export function parseAdmLine(line: string, ctx: AdmDateContext): ParsedAdmEvent | null {
  const header = HEADER_DATE_RE.exec(line);
  if (header) {
    ctx.baseDate = new Date(Date.UTC(+header[1], +header[2] - 1, +header[3]));
    ctx.dayOffsetMs = 0;
    ctx.prevTimeMs = -1;
    return null;
  }

  const time = TIME_RE.exec(line);
  if (!time) return null;
  const hour = +time[1];
  const minute = +time[2];
  const second = +time[3];
  const timeMs = (hour * 3600 + minute * 60 + second) * 1000;
  if (ctx.prevTimeMs >= 0 && timeMs < ctx.prevTimeMs - 60_000) ctx.dayOffsetMs += 86_400_000;
  ctx.prevTimeMs = timeMs;
  const occurredAt = ctx.baseDate
    ? wallClockToUtc(ctx.baseDate, ctx.dayOffsetMs, hour, minute, second, ctx.timeZone)
    : null;
  const timestampStatus: AdmParseStatus = ctx.baseDate ? 'OK' : 'UNRESOLVED_TIMESTAMP';

  const content = line.replace(/^\d{2}:\d{2}:\d{2}\s*\|?\s*/, '');
  const hasPlayer = /Player\s*"/.test(content) || /"[^"]+"\s*\(/.test(content);

  const finalize = (event: ParsedAdmEvent): ParsedAdmEvent => {
    event.occurredAt = occurredAt;
    if (event.parseStatus === 'OK') event.parseStatus = timestampStatus;
    return event;
  };

  if (/\bis connected\b/i.test(content) || /\)\s*connected\b/i.test(content)) {
    return finalize(fill(content, 'PLAYER_CONNECTED', extractActor(content)));
  }
  if (/\bhas been disconnected\b/i.test(content) || /\)\s*disconnected\b/i.test(content)) {
    return finalize(fill(content, 'PLAYER_DISCONNECTED', extractActor(content)));
  }

  const flag = parseFlagAction(content);
  if (flag) return finalize(flag);

  if (/committed suicide/i.test(content)) {
    const event = fill(content, 'PLAYER_SUICIDE', extractActor(content));
    event.toolOrWeapon = extractWeapon(content);
    return finalize(event);
  }

  const killedByIndex = content.search(/\bkilled by\b/i);
  if (killedByIndex >= 0) {
    const victimSegment = content.slice(0, killedByIndex);
    const killerSegment = content.slice(killedByIndex + 'killed by'.length).trim();
    const victim = extractActor(victimSegment);
    const event = emptyEvent(content, 'UNKNOWN', 'OK');
    event.actorName = victim.name;
    event.actorGameId = victim.id;
    event.actorPosition = victim.pos;

    if (/^\[vehicle\]/i.test(killerSegment) || /\bat speed\s+\d+(?:\.\d+)?\s*km\/h/i.test(killerSegment)) {
      event.eventType = 'VEHICLE_DEATH';
      event.targetName = extractVehicleCause(killerSegment);
      return finalize(event);
    }

    const killerIsPlayer = /Player\s*"|"[^"]+"\s*\(id=/i.test(killerSegment);
    if (killerIsPlayer) {
      event.eventType = 'PLAYER_KILLED';
      const killer = extractActor(killerSegment);
      event.targetName = killer.name;
      event.targetGameId = killer.id;
      event.targetPosition = killer.pos;
      event.toolOrWeapon = extractWeapon(killerSegment);
      const distance = DISTANCE_RE.exec(killerSegment);
      event.distanceMeters = distance ? Number(distance[1]) : null;
    } else {
      event.eventType = 'NPC_KILL';
      event.targetName = killerSegment.replace(/\s+with\s+.*$/i, '').replace(/[.\s]+$/, '').trim() || null;
    }
    return finalize(event);
  }

  if (/\bbled out\b|\bdied\b/i.test(content)) {
    return finalize(fill(content, 'PLAYER_DIED', extractActor(content)));
  }

  if (/\bhit by\b/i.test(content)) {
    const fatalVehicle = /\(DEAD\)/i.test(content)
      && (/\[vehicle\]/i.test(content) || /\bat speed\s+\d+(?:\.\d+)?\s*km\/h/i.test(content));
    const event = fill(content, fatalVehicle ? 'VEHICLE_DEATH' : 'PLAYER_HIT', extractActor(content));
    if (fatalVehicle) event.targetName = extractVehicleCause(content);
    if (!fatalVehicle) {
      const details = parsePvpHitDetails(content);
      if (details) {
        const killerSegment = content.slice(content.search(/\bhit by\b/i) + 'hit by'.length);
        const killer = extractActor(killerSegment);
        event.targetName = killer.name;
        event.targetGameId = killer.id;
        event.targetPosition = killer.pos;
        event.toolOrWeapon = details.weapon;
      }
    }
    return finalize(event);
  }

  const build = parseBuildAction(content);
  if (build) {
    const event = fill(content, build.type, extractActor(content));
    event.objectType = build.object;
    event.toolOrWeapon = build.tool;
    return finalize(event);
  }

  if (hasPlayer && POS_RE.test(content) && isBarePlayerPosition(content)) {
    return finalize(fill(content, 'PLAYER_POSITION', extractActor(content)));
  }

  if (hasPlayer) return finalize(emptyEvent(content, 'UNKNOWN', 'UNKNOWN'));
  return null;
}
