/**
 * Killfeed-ADM-Parser fuer DayZ.
 *
 * DayZ-Tagebuch-Format (Beispielzeilen):
 *
 *   16:42:11 | Player "Victim" (DEAD) (id=765... pos=<1234.5,6789.0,123.4>) killed by Player "Killer" (id=765... pos=<2000.0,3000.0,150.0>) with Mosin 91/30 from 187.4 meters
 *   16:43:55 | Player "Victim" (DEAD) (id=765... pos=<1234.5,6789.0,123.4>) committed suicide
 *   16:45:12 | Player "Victim" (DEAD) (id=765... pos=<1234.5,6789.0,123.4>) killed by Wolf
 *   16:46:00 | Player "Victim" (DEAD) (id=765... pos=<1234.5,6789.0,123.4>) died. Stats> Water: 0.0 ...
 *   16:47:11 | Player "Victim" (DEAD) (id=765... pos=<1234.5,6789.0,123.4>) hit by [vehicle] OffroadHatchback at speed 78 km/h
 *
 * Wir parsen ausschliesslich (DEAD)-Zeilen, alles andere ist nicht-toedlich.
 *
 * Kategorien:
 *   - VEHICLE  -> "[vehicle]" oder explizite Vehicle-Hits
 *   - SUICIDE  -> "committed suicide"
 *   - DEATH    -> "killed by Player ..." oder "died ..." mit Killer-Info
 *   - NPC      -> "killed by <Mob>" ohne Player-Klausel (Wolf, Bear, Zombie, Infected)
 */

export type KillCategory = 'DEATH' | 'SUICIDE' | 'NPC' | 'VEHICLE';

export interface KillEvent {
  category: KillCategory;
  occurredAt: Date;
  shooterName?: string;
  shooterPos?: string;
  victimName: string;
  victimPos?: string;
  weapon?: string;
  distance?: number;
  rawLine: string;
}

const HEADER_DATE_RE = /AdminLog started on (\d{4}-\d{2}-\d{2})/;
const TIME_RE = /^(\d{2}):(\d{2}):(\d{2})/;

// (DEAD)-Zeilen — wir matchen Victim + Position, dann Suffix-Klausel
const DEAD_RE = /Player "([^"]+)"\s*\(DEAD\)(?:\s*\(id=[^)]*pos=<([^>]+)>\))?\s+(.+)$/;
// Killer-Klausel: "killed by Player "Name" (id=... pos=<x,y,z>) with Weapon from N meters"
const KILLER_PLAYER_RE = /killed by Player "([^"]+)"(?:\s*\(id=[^)]*pos=<([^>]+)>\))?(?:\s+with\s+(.+?))?(?:\s+from\s+([\d.]+)\s*meters?)?\s*$/;
// NPC-Killer: "killed by <Wort(e)>" — z.B. "killed by Wolf", "killed by Infected"
const KILLER_NPC_RE = /killed by\s+(?!Player\b)([A-Za-z][A-Za-z0-9_ ]{1,40})\s*$/;
// Suicide
const SUICIDE_RE = /committed suicide/i;
// Vehicle: "hit by [vehicle] X" oder "killed by ... at speed"
const VEHICLE_RE = /\[vehicle\]|at speed\s+\d+\s*km\/h/i;

export interface ParseKillsOptions {
  /** Bereits zuvor gesehener Byte-Offset; nur Zeilen ab diesem Offset werden geparst. */
  startOffset?: number;
  /** Wenn gesetzt, wird das Datum aus dem Filenamen als Fallback verwendet. */
  fileNameForFallbackDate?: string;
}

export interface ParseKillsResult {
  events: KillEvent[];
  /** Neuer Byte-Offset (Laenge des verarbeiteten Contents in UTF-8 Bytes). */
  newOffset: number;
}

function deriveBaseDate(content: string, fileNameForFallbackDate?: string): Date {
  const lines = content.split(/\r?\n/, 5);
  for (const line of lines) {
    const m = HEADER_DATE_RE.exec(line);
    if (m) {
      const [y, mo, d] = m[1].split('-').map(Number);
      return new Date(Date.UTC(y, mo - 1, d));
    }
  }
  if (fileNameForFallbackDate) {
    const fm = /(\d{4})-(\d{2})-(\d{2})/.exec(fileNameForFallbackDate);
    if (fm) return new Date(Date.UTC(+fm[1], +fm[2] - 1, +fm[3]));
  }
  return new Date();
}

export function parseKills(content: string, opts: ParseKillsOptions = {}): ParseKillsResult {
  const { startOffset = 0, fileNameForFallbackDate } = opts;
  const totalBytes = Buffer.byteLength(content, 'utf8');
  // Schneide auf nicht-verarbeiteten Bereich (zeilenweise, wir suchen das naechste \n nach startOffset)
  let scanContent = content;
  if (startOffset > 0 && startOffset < totalBytes) {
    const slice = Buffer.from(content, 'utf8').subarray(startOffset).toString('utf8');
    const nlIdx = slice.indexOf('\n');
    scanContent = nlIdx >= 0 ? slice.slice(nlIdx + 1) : '';
  }

  const baseDate = deriveBaseDate(content, fileNameForFallbackDate);
  const lines = scanContent.split(/\r?\n/);
  const out: KillEvent[] = [];

  let dayOffsetMs = 0;
  let prevTimeMs = -1;

  for (const line of lines) {
    const tm = TIME_RE.exec(line);
    if (!tm) continue;
    const h = +tm[1], mi = +tm[2], s = +tm[3];
    const timeMs = (h * 3600 + mi * 60 + s) * 1000;
    if (prevTimeMs >= 0 && timeMs < prevTimeMs - 60_000) {
      dayOffsetMs += 86_400_000;
    }
    prevTimeMs = timeMs;
    const ts = new Date(baseDate.getTime() + dayOffsetMs + timeMs);

    const dm = DEAD_RE.exec(line);
    if (!dm) continue;
    const victimName = dm[1];
    const victimPos = dm[2] || undefined;
    const tail = dm[3];

    // Vehicle
    if (VEHICLE_RE.test(tail)) {
      const weaponMatch = /\[vehicle\]\s+([A-Za-z0-9_]+)/.exec(tail);
      out.push({
        category: 'VEHICLE',
        occurredAt: ts,
        victimName,
        victimPos,
        weapon: weaponMatch ? weaponMatch[1] : undefined,
        rawLine: line,
      });
      continue;
    }

    // Suicide
    if (SUICIDE_RE.test(tail)) {
      out.push({ category: 'SUICIDE', occurredAt: ts, victimName, victimPos, rawLine: line });
      continue;
    }

    // Player-Kill
    const pk = KILLER_PLAYER_RE.exec(tail);
    if (pk) {
      out.push({
        category: 'DEATH',
        occurredAt: ts,
        shooterName: pk[1],
        shooterPos: pk[2] || undefined,
        victimName,
        victimPos,
        weapon: pk[3]?.trim() || undefined,
        distance: pk[4] ? Number(pk[4]) : undefined,
        rawLine: line,
      });
      continue;
    }

    // NPC-Kill
    const nk = KILLER_NPC_RE.exec(tail);
    if (nk) {
      out.push({
        category: 'NPC',
        occurredAt: ts,
        shooterName: nk[1].trim(),
        victimName,
        victimPos,
        rawLine: line,
      });
      continue;
    }
    // sonst ignorieren (z. B. "died. Stats> ...")
  }

  return { events: out, newOffset: totalBytes };
}
