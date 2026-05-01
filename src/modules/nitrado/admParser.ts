/**
 * ADM-Parser fuer DayZ-Server-Logfiles.
 *
 * Format-Beispiel-Zeile (DayZ ADM):
 *   16:42:11 | Player "MaxMustermann" (id=76561198... pos=<x,y,z>) connected
 *   17:23:08 | Player "MaxMustermann" (id=76561198... pos=<x,y,z>) disconnected
 *
 * Output: Sessions (login/logout-Pairs) pro steam64.
 * Bei haengenden Sessions (kein logout vor Datei-Ende) wird der letzte
 * bekannte Zeitpunkt im File als Logout angenommen (best-effort, ohne diese
 * Heuristik wuerde Spielzeit verloren gehen, wenn Server-Restart die Session
 * abschneidet).
 */

export interface AdmSession {
  steam64: string;
  playerName: string;
  loginAt: Date;
  logoutAt: Date;
  durationMinutes: number;
}

const STEAM64_RE = /id=(7656\d{13})/;
const NAME_RE = /Player "([^"]+)"/;
// Datum oben im File: AdminLog started on 2025-04-30 at 16:00:00
const HEADER_DATE_RE = /AdminLog started on (\d{4}-\d{2}-\d{2})/;
const TIME_RE = /^(\d{2}):(\d{2}):(\d{2})/;
const CONNECTED_RE = /\)\s+connected\b/;
const DISCONNECTED_RE = /\)\s+disconnected\b/;

interface OpenSession {
  playerName: string;
  loginAt: Date;
}

export function parseAdm(content: string, fileNameForFallbackDate?: string): AdmSession[] {
  const lines = content.split(/\r?\n/);
  let baseDate: Date | null = null;
  for (const line of lines.slice(0, 5)) {
    const m = HEADER_DATE_RE.exec(line);
    if (m) {
      const [y, mo, d] = m[1].split('-').map(Number);
      baseDate = new Date(Date.UTC(y, mo - 1, d));
      break;
    }
  }
  if (!baseDate && fileNameForFallbackDate) {
    // Filename-Format DayZServer_X1_x64_2025-04-30_16-00-00.ADM
    const fm = /(\d{4})-(\d{2})-(\d{2})/.exec(fileNameForFallbackDate);
    if (fm) baseDate = new Date(Date.UTC(+fm[1], +fm[2] - 1, +fm[3]));
  }
  if (!baseDate) baseDate = new Date(); // Letzter Notnagel — heute

  const open = new Map<string, OpenSession>(); // key=steam64
  const sessions: AdmSession[] = [];
  let lastSeenAt = new Date(baseDate.getTime());

  let dayOffsetMs = 0;
  let prevTimeMs = -1;

  for (const line of lines) {
    const tm = TIME_RE.exec(line);
    if (!tm) continue;
    const h = +tm[1], mi = +tm[2], s = +tm[3];
    const timeMs = (h * 3600 + mi * 60 + s) * 1000;
    if (prevTimeMs >= 0 && timeMs < prevTimeMs - 60_000) {
      // Tageswechsel im File
      dayOffsetMs += 86_400_000;
    }
    prevTimeMs = timeMs;
    const ts = new Date(baseDate.getTime() + dayOffsetMs + timeMs);
    lastSeenAt = ts;

    const sm = STEAM64_RE.exec(line);
    const nm = NAME_RE.exec(line);
    if (!sm || !nm) continue;
    const steam64 = sm[1];
    const playerName = nm[1];

    if (CONNECTED_RE.test(line)) {
      open.set(steam64, { playerName, loginAt: ts });
    } else if (DISCONNECTED_RE.test(line)) {
      const o = open.get(steam64);
      if (o) {
        open.delete(steam64);
        const dur = Math.max(0, Math.round((ts.getTime() - o.loginAt.getTime()) / 60_000));
        if (dur > 0) {
          sessions.push({ steam64, playerName: o.playerName, loginAt: o.loginAt, logoutAt: ts, durationMinutes: dur });
        }
      }
    }
  }

  // Haengende Sessions — Logout = lastSeenAt
  for (const [steam64, o] of open) {
    const dur = Math.max(0, Math.round((lastSeenAt.getTime() - o.loginAt.getTime()) / 60_000));
    if (dur > 0) {
      sessions.push({ steam64, playerName: o.playerName, loginAt: o.loginAt, logoutAt: lastSeenAt, durationMinutes: dur });
    }
  }

  return sessions;
}

/** Aggregiert Sessions zu (steam64 -> Minuten). */
export function aggregateMinutesByPlayer(sessions: AdmSession[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of sessions) {
    out.set(s.steam64, (out.get(s.steam64) ?? 0) + s.durationMinutes);
  }
  return out;
}
