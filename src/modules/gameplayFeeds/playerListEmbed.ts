import { EmbedBuilder } from 'discord.js';
import { createHash } from 'node:crypto';
import { safeEmbedField } from '../../utils/embedSanitize';
import { izurvivePositionUrl } from './embedBuilder';

export interface PlayerListEntry {
  gameId: string;
  playerName: string;
  position: string | null;
}

const FIELD_LIMIT = 900;
const MAX_EMBEDS = 10;
// Discord begrenzt die Summe aller Embed-Texte einer Nachricht auf 6000 Zeichen.
// Fuer Titel, Feldnamen, Serveralias und Footer bleibt bewusst Reserve.
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

function positionValue(position: string | null, withLink: boolean): string {
  const clean = cleanPosition(position);
  if (!clean) return 'Position unbekannt';
  if (!withLink) return safeEmbedField(clean, 128);
  const link = izurvivePositionUrl(clean);
  return link ? `[${safeEmbedField(clean, 128)}](${link})` : safeEmbedField(clean, 128);
}

function playerLine(entry: PlayerListEntry, showCoordinates: boolean, withLinks: boolean): string {
  const name = safeEmbedField(entry.playerName.trim() || 'Unbekannt', 128);
  return showCoordinates ? `• ${name} — ${positionValue(entry.position, withLinks)}` : `• ${name}`;
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

function snapshotTimestamp(value: Date): string {
  return `<t:${Math.floor(value.getTime() / 1000)}:F>`;
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
  const generatedAt = args.generatedAt ?? new Date();

  let lines: string[];
  if (entries.length === 0) {
    lines = ['Keine Spieler online.'];
  } else if (!args.showCoordinates) {
    lines = entries.map(entry => playerLine(entry, false, false));
  } else {
    const linked = entries.map(entry => playerLine(entry, true, true));
    // iZurvive-Links sind die bevorzugte Darstellung. Falls ihre URL-Laenge
    // die Discord-Nachricht ueber das 6000-Zeichen-Limit treiben wuerde,
    // bleiben alle Koordinaten sichtbar, aber ohne Link-Overhead.
    const linkedLength = linked.reduce((sum, line) => sum + line.length + 1, 0);
    lines = linkedLength <= PLAYER_LINES_BUDGET
      ? linked
      : entries.map(entry => playerLine(entry, true, false));
  }

  const fitted = fitLinesToMessageBudget(lines);
  const chunks = chunkLines(fitted);
  const embeds: EmbedBuilder[] = [];

  for (let index = 0; index < chunks.length; index++) {
    const embed = new EmbedBuilder()
      .setColor(parseHex(args.embedColor))
      .setTitle(index === 0 ? '🌐 Online List' : `🌐 Online List · Fortsetzung ${index + 1}`);

    if (index === 0) {
      embed.addFields(
        { name: 'Server', value: safeEmbedField(args.serverAlias || 'DayZ-Server', 256), inline: false },
        { name: 'Zeitpunkt', value: snapshotTimestamp(generatedAt), inline: false },
        { name: 'Online', value: String(entries.length), inline: true },
      );
    }

    embed.addFields({ name: index === 0 ? 'Spieler' : 'Weitere Spieler', value: chunks[index] });
    if (index === chunks.length - 1) {
      embed.setFooter({
        text: args.showCoordinates
          ? 'Koordinaten aus dem letzten gueltigen ADM-Positionsereignis der aktuellen Sitzung.'
          : 'Koordinaten sind deaktiviert.',
      });
    }
    embeds.push(embed);
  }

  return embeds.slice(0, MAX_EMBEDS);
}
