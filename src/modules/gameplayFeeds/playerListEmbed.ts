import { EmbedBuilder } from 'discord.js';
import { createHash } from 'node:crypto';
import { safeEmbedField } from '../../utils/embedSanitize';
import { compactDescription, compactEmbed } from '../../utils/embedDesign';
import { izurvivePositionUrl } from './embedBuilder';

export interface PlayerListEntry {
  gameId: string;
  playerName: string;
  position: string | null;
}

// Discord erlaubt bis zu 4096 Zeichen pro Embed-Description (bereits separat
// ueber capCompactDescription/EMBED_DESCRIPTION_LIMIT abgesichert). Der
// vorherige Wert von 900 war eine willkuerlich niedrige Grenze weit unter dem
// echten Limit und erzwang schon ab ca. 10 Spielern eine neue Seite. Mit
// Marge fuer die Kopfzeile ("Online List · N Players") lasst dieser Wert bis
// zu 50 Spieler (das explizit geforderte Minimum) und typischerweise deutlich
// mehr auf einer Seite zu, bevor eine Fortsetzung noetig wird.
const FIELD_LIMIT = 4000;
const MAX_EMBEDS = 10;
// Discord begrenzt die Summe aller Embed-Texte einer Nachricht auf 6000 Zeichen.
// Fuer kompakte Kopfzeilen, Serveralias und Footer bleibt bewusst Reserve.
const PLAYER_LINES_BUDGET = 5000;

function parseHex(value: string): number {
  const parsed = Number.parseInt(value.replace(/^#/, ''), 16);
  return Number.isNaN(parsed) ? 0x2563eb : parsed;
}

function cleanPosition(position: string | null): string | null {
  if (!position) return null;
  const clean = position.replace(/[<>]/g, '').trim().slice(0, 128);
  return clean || null;
}

function positionValue(position: string | null, withLink: boolean): string | null {
  const clean = cleanPosition(position);
  // Ein CONNECT kann im aktuellen ADM-File vor dem ersten PLAYER_POSITION
  // eintreffen. In diesem kurzen Fenster darf die Online-Liste keinen falschen
  // oder veralteten Wert anzeigen. Der Spieler bleibt sichtbar; die Position
  // erscheint erst, sobald ein gueltiges Positionsereignis NACH diesem Connect
  // vorhanden ist. Der State-Hash sorgt danach fuer das Live-Edit.
  if (!clean) return null;
  if (!withLink) return safeEmbedField(clean, 128);
  const link = izurvivePositionUrl(clean);
  return link ? `[${safeEmbedField(clean, 128)}](${link})` : safeEmbedField(clean, 128);
}

function playerLine(entry: PlayerListEntry, showCoordinates: boolean, withLinks: boolean): string {
  const name = safeEmbedField(entry.playerName.trim() || 'Unbekannt', 128);
  if (!showCoordinates) return `• ${name}`;
  const position = positionValue(entry.position, withLinks);
  return position ? `• ${name} — ${position}` : `• ${name}`;
}

function fitLinesToMessageBudget(lines: string[]): string[] {
  const fitted: string[] = [];
  let used = 0;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].slice(0, FIELD_LIMIT);
    const extra = (fitted.length > 0 ? 1 : 0) + line.length;
    if (used + extra > PLAYER_LINES_BUDGET) {
      const omitted = lines.length - index;
      const marker = `• … ${omitted} weitere Spieler konnten wegen des Discord-Limits nicht dargestellt werden.`;
      while (fitted.length > 0 && used + 1 + marker.length > PLAYER_LINES_BUDGET) {
        const removed = fitted.pop()!;
        used -= removed.length + (fitted.length > 0 ? 1 : 0);
      }
      fitted.push(marker);
      return fitted;
    }
    fitted.push(line);
    used += extra;
  }
  return fitted;
}

function chunkLines(lines: string[]): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length > FIELD_LIMIT) {
      if (current) chunks.push(current);
      current = line;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  return chunks.slice(0, MAX_EMBEDS);
}

export function playerListStateHash(entries: PlayerListEntry[], showCoordinates: boolean): string {
  const stable = entries
    .map(entry => {
      const identity = `${entry.gameId}\u0000${entry.playerName.trim().toLocaleLowerCase('de-DE')}`;
      // Wenn Koordinaten sichtbar sind, ist eine Positionsaenderung auch eine
      // sichtbare Zustandsaenderung. Bei deaktivierten Koordinaten bleibt reine
      // Bewegung absichtlich ohne Discord-Edit.
      return showCoordinates ? `${identity}\u0000${cleanPosition(entry.position) ?? ''}` : identity;
    })
    .sort()
    .join('\u0001');
  return createHash('sha256').update(`${showCoordinates ? 'coords' : 'names'}\u0000${stable}`).digest('hex');
}

export function buildPlayerListEmbeds(args: {
  serverAlias: string;
  entries: PlayerListEntry[];
  showCoordinates: boolean;
  embedColor: string;
  generatedAt?: Date;
}): EmbedBuilder[] {
  const entries = [...args.entries].sort((a, b) => a.playerName.localeCompare(b.playerName, 'de-DE'));

  let lines: string[];
  if (entries.length === 0) {
    lines = ['Keine Spieler online.'];
  } else if (!args.showCoordinates) {
    lines = entries.map(entry => playerLine(entry, false, false));
  } else {
    const linked = entries.map(entry => playerLine(entry, true, true));
    // iZurvive-Links sind die bevorzugte Darstellung. Ihr URL-Overhead darf
    // aber nicht dazu fuehren, dass schon deutlich weniger als 50 Spieler auf
    // die erste Seite passen (explizite Anforderung: bis zu 50 Spieler vor
    // einer 2. Seite). Deshalb wird gezielt geprueft, ob bereits die ersten
    // 50 Eintraege MIT Link in eine einzelne Seite passen wuerden - reicht das
    // nicht, verzichtet die gesamte Liste auf Links zugunsten der Spieleranzahl
    // pro Seite. Das bestehende Gesamt-Budget schuetzt zusaetzlich weiterhin
    // vor einer Ueberschreitung des 6000-Zeichen-Nachrichtenlimits.
    const MIN_PLAYERS_PER_PAGE = 50;
    const firstPageLinkedLength = linked.slice(0, MIN_PLAYERS_PER_PAGE).reduce((sum, line) => sum + line.length + 1, 0);
    const linkedLength = linked.reduce((sum, line) => sum + line.length + 1, 0);
    lines = firstPageLinkedLength <= FIELD_LIMIT && linkedLength <= PLAYER_LINES_BUDGET
      ? linked
      : entries.map(entry => playerLine(entry, true, false));
  }

  const fitted = fitLinesToMessageBudget(lines);
  const chunks = chunkLines(fitted);
  const embeds: EmbedBuilder[] = [];
  const serverAlias = safeEmbedField(args.serverAlias || 'DayZ-Server', 256);

  for (let index = 0; index < chunks.length; index++) {
    const heading = index === 0
      ? `🌐 • Online List · ${entries.length} Players`
      : `🌐 • Online List · ${entries.length} Players · Fortsetzung ${index + 1}`;
    const embed = compactEmbed(parseHex(args.embedColor), serverAlias)
      .setDescription(compactDescription(heading, [chunks[index]]));
    embeds.push(embed);
  }

  return embeds.slice(0, MAX_EMBEDS);
}
