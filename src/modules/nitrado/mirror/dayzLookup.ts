/**
 * DayZ-Server-Lookup für die AI-Schicht.
 *
 * Beantwortet Fragen wie:
 *   - "Wie ist die Tag/Nacht-Zeit eingestellt?"
 *   - "Wie viele Slots hat der Server?"
 *   - "Welche Mods laufen?"
 *   - "Was ist die nominal-Anzahl von AKM in types.xml?"
 *
 * Datenquelle: NitradoMirror (lokal, kein Token nötig).
 * Anonymisierung: alle ausgegebenen Werte durchlaufen den Redactor —
 *   Hostname, IP, Port, Whitelist, Banlist usw. werden NIE im Klartext
 *   ausgespielt. Nur funktionale Settings (timeAcceleration, slots, mods,
 *   loot-Werte, Mission-Daten) erscheinen.
 */

import prisma from '../../../database/prisma';
import { logger } from '../../../utils/logger';
import { getLatestSnapshot, getSettings, findFiles, getFile, getCfgValue } from './queryApi';
import { isSensitiveKey, redactValue, redactText, PLACEHOLDER, type RedactOptions } from './redactor';

export interface DayZAnswer {
  /** menschlich lesbarer Antwort-Block, fertig zum Einkippen in einen System-Prompt. */
  text: string;
  /** Snapshot, aus dem die Daten stammen (Zeitstempel). */
  snapshotAt: Date | null;
  /** Quellen-Pfade (Datei-Pfade im Mirror). */
  sources: string[];
  /** True, wenn überhaupt Daten gefunden wurden. */
  found: boolean;
}

const EMPTY: DayZAnswer = { text: '', snapshotAt: null, sources: [], found: false };

/** Heuristik: Wirkt die Frage wie eine DayZ-Server-Konfig-Frage? */
export function isDayZServerQuestion(question: string): boolean {
  if (!question) return false;
  const q = question.toLowerCase();
  // Direkte Themen-Indikatoren
  const themes = [
    'tag', 'nacht', 'tageszeit', 'nachtzeit', 'time accel', 'timeacceleration',
    'slots', 'spielerzahl', 'maxplayer', 'max player', 'spieler', 'queue',
    'mod', 'mods', 'workshop',
    'loot', 'spawn', 'respawn', 'persistence',
    'types.xml', 'events.xml', 'globals.xml', 'serverdz', 'init.c', 'cfgeconomy',
    'mission', 'map', 'karte',
    'restart', 'wartung',
    'cfg', 'config', 'einstellung', 'einstellungen', 'eingestellt',
    'dayz server', 'unser server', 'der server',
  ];
  return themes.some((t) => q.includes(t));
}

/**
 * Holt für die Guild den letzten erfolgreichen Snapshot UND die zugehörige
 * Connection-Meta. Liefert null, falls keine Connection oder kein Snapshot.
 */
async function pickSnapshotForGuild(guildId: string): Promise<{
  snapshotId: string;
  snapshotAt: Date;
  serverName: string | null;
  serviceId: string | null;
} | null> {
  // alle Connections der Guild — wir nehmen die erste mit Snapshot
  const conns = await prisma.nitradoConnection.findMany({
    where: { guildId },
    select: { id: true, alias: true, serviceId: true, nitradoServerId: true },
    orderBy: { slot: 'asc' },
  });
  for (const c of conns) {
    const s = await getLatestSnapshot(guildId, c.id);
    if (s) {
      return {
        snapshotId: s.id,
        snapshotAt: s.startedAt,
        serverName: c.alias ?? null,
        serviceId: c.serviceId ?? c.nitradoServerId ?? null,
      };
    }
  }
  return null;
}

/** Ausgewählte funktionale Settings, die für AI-Antworten relevant sind. */
const RELEVANT_GENERAL_KEYS = [
  'serverTimeAcceleration', 'serverNightTimeAcceleration',
  'serverTimePersistent', 'serverTime',
  'maxPlayers', 'queueSize',
  'persistence', 'persistencePeriod',
  'lootHistory', 'respawnTime', 'instanceId',
  'disable3rdPerson', 'disableVoN', 'enableMouseAndKeyboard',
  'mission', 'template',
  'modIds', 'mods',
];

/**
 * Filtert ein verschachteltes Settings-Objekt rekursiv nach RELEVANT_GENERAL_KEYS
 * und liefert eine flache Key→Wert-Liste mit Pfad. Werte werden anonymisiert,
 * wenn der Key sensibel ist.
 */
function flattenRelevantSettings(
  obj: unknown,
  opts: RedactOptions,
  prefix = '',
  out: Array<{ key: string; value: unknown }> = [],
): Array<{ key: string; value: unknown }> {
  if (!obj || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (RELEVANT_GENERAL_KEYS.includes(k)) {
      out.push({ key: path, value: isSensitiveKey(k) ? redactValue(k, v, opts) : redactValue(k, v, opts) });
      continue;
    }
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      flattenRelevantSettings(v, opts, path, out);
    }
  }
  return out;
}

/**
 * Hauptfunktion: liefert einen anonymisierten, autoritativen Antwort-Block.
 * `null` (bzw. found=false) wenn kein Snapshot existiert → AI antwortet wie bisher.
 */
export async function lookupDayZServer(guildId: string | null | undefined, question: string): Promise<DayZAnswer> {
  if (!guildId) return EMPTY;
  if (!isDayZServerQuestion(question)) return EMPTY;

  try {
    const picked = await pickSnapshotForGuild(guildId);
    if (!picked) return EMPTY;

    const opts: RedactOptions = {
      serverName: picked.serverName,
      serviceId: picked.serviceId,
    };
    const sources: string[] = [];

    const settings = await getSettings(picked.snapshotId);
    const relevant = settings?.gameserver
      ? flattenRelevantSettings(settings.gameserver, opts)
      : [];

    // Spezial: explizite Datei-Lookups je nach Frageninhalt
    const q = question.toLowerCase();
    const fileBlocks: string[] = [];

    if (/serverdz|cfg|tag|nacht|time accel|slot|maxplayer|persistence|3rd|von/i.test(q)) {
      const cfgFiles = await findFiles(picked.snapshotId, 'serverDZ.cfg', 5);
      for (const f of cfgFiles) {
        const interesting = ['serverTimeAcceleration', 'serverNightTimeAcceleration', 'maxPlayers', 'instanceId', 'persistent', 'disable3rdPerson', 'disableVoN'];
        const lines: string[] = [];
        for (const k of interesting) {
          const v = await getCfgValue(picked.snapshotId, f.path, k);
          if (v !== null) {
            lines.push(`  ${k} = ${isSensitiveKey(k) ? PLACEHOLDER.generic : redactText(v, opts)}`);
          }
        }
        if (lines.length > 0) {
          fileBlocks.push(`Aus serverDZ.cfg:\n${lines.join('\n')}`);
          sources.push(f.path);
        }
      }
    }

    if (/types\.xml|nominal|loot/i.test(q)) {
      const xs = await findFiles(picked.snapshotId, 'types.xml', 3);
      for (const f of xs) sources.push(f.path);
      if (xs.length > 0) {
        fileBlocks.push(`types.xml liegt im Mirror (${xs.length} Datei(en) gefunden). Detail-Abfragen über die Mirror-API möglich.`);
      }
    }

    if (/events\.xml|spawn/i.test(q)) {
      const xs = await findFiles(picked.snapshotId, 'events.xml', 3);
      for (const f of xs) sources.push(f.path);
      if (xs.length > 0) {
        fileBlocks.push(`events.xml liegt im Mirror (${xs.length} Datei(en) gefunden).`);
      }
    }

    if (/init\.c|init/i.test(q)) {
      const xs = await findFiles(picked.snapshotId, 'init.c', 3);
      for (const f of xs) sources.push(f.path);
      if (xs.length > 0) {
        fileBlocks.push(`init.c liegt im Mirror (${xs.length} Datei(en) gefunden).`);
      }
    }

    // Kein einziger Treffer → leere Antwort
    if (relevant.length === 0 && fileBlocks.length === 0) return EMPTY;

    const lines: string[] = [];
    lines.push('AUTORITATIVE QUELLE — DayZ-Server (anonymisiert, lokaler Snapshot):');
    lines.push(`Snapshot vom ${picked.snapshotAt.toISOString().slice(0, 16).replace('T', ' ')} UTC.`);
    lines.push('');
    if (relevant.length > 0) {
      lines.push('Funktionale Settings (Auszug, sensible Werte sind durch Platzhalter ersetzt):');
      for (const r of relevant) {
        lines.push(`  ${r.key} = ${formatVal(r.value)}`);
      }
    }
    if (fileBlocks.length > 0) {
      lines.push('');
      for (const b of fileBlocks) lines.push(b);
    }
    lines.push('');
    lines.push('Wichtige Regeln für die Antwort an den Nutzer:');
    lines.push('- Stütze deine Antwort AUSSCHLIESSLICH auf diese Werte.');
    lines.push('- Erwähne NIEMALS Server-Name, IP, Port, Service-ID, Whitelist- oder Bann-Einträge im Klartext. Verwende Platzhalter wie [SERVER], [IP], [PORT].');
    lines.push('- Wenn ein Wert hier Platzhalter ist, sage "vertraulich" statt zu raten.');
    lines.push('- Bei Konfig-Änderungen: erkläre WO (z. B. Nitrado-Webinterface → Settings → General oder serverDZ.cfg) und dass ein Server-Restart nötig ist. Führe die Änderung NICHT selbst durch.');

    return {
      text: lines.join('\n'),
      snapshotAt: picked.snapshotAt,
      sources,
      found: true,
    };
  } catch (e) {
    logger.warn('[DayZ-Lookup] Fehler', { err: (e as Error).message });
    return EMPTY;
  }
}

function formatVal(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try { return JSON.stringify(v); } catch { return String(v); }
}
