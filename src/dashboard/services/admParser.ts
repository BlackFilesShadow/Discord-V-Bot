/**
 * ADM-/RPT-Parser fuer DayZ-Server-Logs (Phase 2, Spec Sektion 5/13).
 *
 * Wir extrahieren strukturierte Events. ALLE Event-Typen, die einen Spieler
 * betreffen, sind GUID-strict (Spec 13): nur Eintraege mit BattlEye-GUID
 * werden den 8 AI-Auswertungen zugefuehrt. Eintraege ohne GUID werden in
 * `unknown`-Statistiken verbucht (sichtbar fuer den Entwickler) — niemals
 * dem Hauptdatensatz hinzugefuegt.
 *
 * ADM-Beispielzeilen:
 *   AdminLog started on 2026-04-21 at 18:30:14
 *   18:31:02 | Player "Max" (id=AbCd... pos=<7456.1, 8123.2, 0.0>) connected
 *   18:32:11 | Player "Max" (id=AbCd... pos=<...>) is connected
 *   18:35:00 | Player "Max" (DEAD) (id=AbCd... pos=<...>) killed by Player "Tom" (id=ZyXw... pos=<...>) with M4-A1 from 152 meters
 *   18:36:00 | Player "Tom" (id=ZyXw... pos=<...>) hit by Zombie into LeftLeg for 12 damage
 *
 * RPT-Logs enthalten Server-Errors, Mod-Loads etc. — wir extrahieren nur
 * grobe Kategorien (ERROR/WARN/INFO) plus Mod-Listen.
 *
 * Performance: Streaming-frei, weil DEV-Uploads max 50 MB sind.
 */
import { isValidBattleyeGuid } from '../../utils/guid';

export type AdmEventKind =
  | 'connect'
  | 'disconnect'
  | 'kill'
  | 'death'        // Tod ohne identifizierten Killer (Sturz, Hunger, Zombie)
  | 'hit'
  | 'placed'       // base building / placed object
  | 'built'
  | 'dismantled'
  | 'unconscious'
  | 'regained'
  | 'chat'
  | 'vehicle'      // Fahrzeug-Interaktion
  | 'unknown';

export interface AdmCoord {
  x: number;
  y: number;
  z: number;
}

export interface AdmActor {
  name: string;
  guid: string | null; // BattlEye-GUID (Spec 13). null => unbekannt.
  pos: AdmCoord | null;
}

export interface AdmEvent {
  ts: Date;          // absoluter Zeitstempel (date-line + Uhrzeit)
  line: number;      // 1-basierte Zeilennummer in der Quelldatei
  kind: AdmEventKind;
  actor: AdmActor;
  target?: AdmActor; // nur fuer kill/hit
  weapon?: string;
  distanceM?: number;
  bodyPart?: string;
  damage?: number;
  vehicle?: string;
  itemOrText?: string; // chat-message / placed-item / built-item
  raw: string;
}

export interface AdmParseResult {
  events: AdmEvent[];
  guidEvents: AdmEvent[];            // events deren actor (und ggf. target) eine GUID haben
  unknownPlayerEvents: number;       // Eintraege ohne GUID (verworfen fuer Analytics)
  startedAt: Date | null;            // aus "AdminLog started on ..."
  totalLines: number;
  parseErrors: number;
}

const RE_HEADER = /^AdminLog started on (\d{4}-\d{2}-\d{2}) at (\d{2}:\d{2}:\d{2})/;
const RE_TIMESTAMPED = /^(\d{2}):(\d{2}):(\d{2})\s*\|\s*(.+)$/;
function parsePlayer(seg: string): AdmActor | null {
  // Variante A: voll mit id+pos
  const m = /Player\s+"([^"]+)"\s*(?:\(([^)]+)\))?\s*\(id=([^\s)]+)?\s*(?:pos=<\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*>)?\s*\)/.exec(seg);
  if (!m) return null;
  const name = m[1];
  // Spec 13: GUID-strict. Nur echte BattlEye-GUIDs (8-64 alphanum) gelten als
  // identifizierter Spieler. Muell wie '', 'Unknown', 'N/A' wird zu null und
  // landet damit korrekt in `unknownPlayerEvents`, NICHT in `guidEvents`.
  const guid = isValidBattleyeGuid(m[3]) ? m[3] : null;
  let pos: AdmCoord | null = null;
  if (m[4] && m[5] && m[6]) {
    pos = { x: parseFloat(m[4]), y: parseFloat(m[5]), z: parseFloat(m[6]) };
  }
  return { name, guid, pos };
}

function buildTs(date: Date | null, hh: number, mm: number, ss: number): Date {
  const d = date ? new Date(date) : new Date(0);
  d.setUTCHours(hh, mm, ss, 0);
  return d;
}

function classify(rest: string): AdmEventKind {
  if (/\bkilled by\b/i.test(rest)) return 'kill';
  if (/\bhit by\b/i.test(rest)) return 'hit';
  if (/\bdied\b|\bbled out\b|\bsuicide\b/i.test(rest)) return 'death';
  if (/\bconnected\b/i.test(rest)) return 'connect';
  if (/\bdisconnected\b/i.test(rest)) return 'disconnect';
  if (/\bplaced\b/i.test(rest)) return 'placed';
  if (/\bbuilt\b/i.test(rest)) return 'built';
  if (/\bdismantled\b/i.test(rest)) return 'dismantled';
  if (/\bis unconscious\b/i.test(rest)) return 'unconscious';
  if (/\bregained consciousness\b/i.test(rest)) return 'regained';
  if (/\bchat\b/i.test(rest)) return 'chat';
  if (/\bvehicle\b|\bcar\b|\btruck\b|\bhelicopter\b/i.test(rest)) return 'vehicle';
  return 'unknown';
}

export function parseAdm(content: string): AdmParseResult {
  const lines = content.split(/\r?\n/);
  const events: AdmEvent[] = [];
  let baseDate: Date | null = null;
  let startedAt: Date | null = null;
  let parseErrors = 0;

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i].trim();
    if (ln.length === 0) continue;

    const hdr = RE_HEADER.exec(ln);
    if (hdr) {
      baseDate = new Date(`${hdr[1]}T${hdr[2]}Z`);
      startedAt = baseDate;
      continue;
    }

    const m = RE_TIMESTAMPED.exec(ln);
    if (!m) continue;
    const hh = parseInt(m[1], 10);
    const mm = parseInt(m[2], 10);
    const ss = parseInt(m[3], 10);
    const rest = m[4];
    const ts = buildTs(baseDate, hh, mm, ss);

    try {
      const kind = classify(rest);
      const actor = parsePlayer(rest);
      if (!actor) continue;

      const ev: AdmEvent = {
        ts,
        line: i + 1,
        kind,
        actor,
        raw: ln,
      };

      // Target-Spieler bei kill/hit: zweiter "Player ..."-Block.
      if (kind === 'kill' || kind === 'hit') {
        const after = rest.slice(rest.indexOf(') ') + 1);
        const target = parsePlayer(after.replace(/^.*?(killed by|hit by)\s*/i, ''));
        if (target) ev.target = target;

        const wep = /with\s+([A-Za-z0-9_-]+)/.exec(rest);
        if (wep) ev.weapon = wep[1];
        const dist = /from\s+(\d+(?:\.\d+)?)\s*meters?/.exec(rest);
        if (dist) ev.distanceM = parseFloat(dist[1]);
        const bp = /into\s+([A-Za-z]+)/.exec(rest);
        if (bp) ev.bodyPart = bp[1];
        const dmg = /for\s+(\d+(?:\.\d+)?)\s*damage/.exec(rest);
        if (dmg) ev.damage = parseFloat(dmg[1]);
      }

      if (kind === 'placed' || kind === 'built' || kind === 'dismantled' || kind === 'chat') {
        const it = rest.match(/(?:placed|built|dismantled|chat[^:]*:)\s*(.+)$/i);
        if (it) ev.itemOrText = it[1].trim().slice(0, 500);
      }
      if (kind === 'vehicle') {
        const veh = /(car|truck|helicopter|boat|atv|sedan|hatchback)/i.exec(rest);
        if (veh) ev.vehicle = veh[1];
      }

      events.push(ev);
    } catch {
      parseErrors++;
    }
  }

  let unknown = 0;
  const guidEvents: AdmEvent[] = [];
  for (const e of events) {
    const actorOk = e.actor.guid !== null;
    const targetOk = e.target ? e.target.guid !== null : true;
    if (actorOk && targetOk) guidEvents.push(e);
    else unknown++;
  }

  return {
    events,
    guidEvents,
    unknownPlayerEvents: unknown,
    startedAt,
    totalLines: lines.length,
    parseErrors,
  };
}

// --- RPT -----------------------------------------------------------------

export interface RptLine {
  line: number;
  level: 'ERROR' | 'WARN' | 'INFO' | 'OTHER';
  text: string;
}

export interface RptParseResult {
  lines: RptLine[];
  counts: { ERROR: number; WARN: number; INFO: number; OTHER: number };
  mods: string[];
  totalLines: number;
}

const RE_RPT_LEVEL = /^\s*(ERROR|WARN(?:ING)?|INFO)\b/i;
const RE_MOD = /\bmod\s*=\s*"([^"]+)"|\b@([A-Za-z0-9_-]+)/i;

export function parseRpt(content: string, maxLines = 5000): RptParseResult {
  const all = content.split(/\r?\n/);
  const counts = { ERROR: 0, WARN: 0, INFO: 0, OTHER: 0 };
  const out: RptLine[] = [];
  const mods = new Set<string>();
  for (let i = 0; i < all.length; i++) {
    const t = all[i];
    if (t.length === 0) continue;
    let level: RptLine['level'] = 'OTHER';
    const lm = RE_RPT_LEVEL.exec(t);
    if (lm) {
      const k = lm[1].toUpperCase();
      level = k.startsWith('WARN') ? 'WARN' : (k as 'ERROR' | 'INFO');
    }
    counts[level]++;
    const mm = RE_MOD.exec(t);
    if (mm) mods.add(mm[1] || mm[2]);
    if (out.length < maxLines && level !== 'OTHER') {
      out.push({ line: i + 1, level, text: t.slice(0, 500) });
    }
  }
  return { lines: out, counts, mods: Array.from(mods).sort(), totalLines: all.length };
}
