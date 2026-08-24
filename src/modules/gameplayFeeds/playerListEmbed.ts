import { EmbedBuilder } from 'discord.js';
import { createHash } from 'node:crypto';
import { safeEmbedField } from '../../utils/embedSanitize';
import { izurvivePositionUrl } from './embedBuilder';

export interface PlayerListEntry {
  gameId: string;
  playerName: string;
  position: string | null;
}

const FIELD_LIMIT = 1024;
const MAX_FIELDS = 25;

function parseHex(value: string): number {
  const parsed = Number.parseInt(value.replace(/^#/, ''), 16);
  return Number.isNaN(parsed) ? 0x2563eb : parsed;
}

function positionValue(position: string | null): string {
  if (!position) return 'Position unbekannt';
  const clean = position.replace(/[<>]/g, '').trim().slice(0, 128);
  if (!clean) return 'Position unbekannt';
  const link = izurvivePositionUrl(clean);
  return link ? `[${safeEmbedField(clean, 128)}](${link})` : safeEmbedField(clean, 128);
}

function playerLine(entry: PlayerListEntry, showCoordinates: boolean): string {
  const name = safeEmbedField(entry.playerName.trim() || 'Unbekannt', 128);
  return showCoordinates ? `• ${name} — ${positionValue(entry.position)}` : `• ${name}`;
}

function chunkLines(lines: string[]): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const line of lines) {
    const safeLine = line.slice(0, FIELD_LIMIT);
    const next = current ? `${current}\n${safeLine}` : safeLine;
    if (next.length > FIELD_LIMIT) {
      chunks.push(current);
      current = safeLine;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  return chunks.slice(0, MAX_FIELDS);
}

export function playerListStateHash(entries: PlayerListEntry[], showCoordinates: boolean): string {
  const stable = entries
    .map(entry => `${entry.gameId}\u0000${entry.playerName.trim().toLocaleLowerCase('de-DE')}`)
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
  const lines = entries.length > 0
    ? entries.map(entry => playerLine(entry, args.showCoordinates))
    : ['Keine Spieler online.'];
  const chunks = chunkLines(lines);
  const embeds: EmbedBuilder[] = [];

  for (let index = 0; index < chunks.length; index++) {
    const embed = new EmbedBuilder()
      .setColor(parseHex(args.embedColor))
      .setTitle(index === 0 ? '🎮 Player List' : `🎮 Player List · Fortsetzung ${index + 1}`)
      .addFields({ name: 'Server', value: safeEmbedField(args.serverAlias || 'DayZ-Server', 256), inline: true });
    if (index === 0) {
      embed.addFields({ name: 'Online', value: String(entries.length), inline: true });
    }
    embed.addFields({ name: index === 0 ? 'Spieler' : 'Weitere Spieler', value: chunks[index] });
    if (index === chunks.length - 1) {
      embed.setFooter({ text: args.showCoordinates ? 'Koordinaten aus dem letzten vorhandenen ADM-Positionsereignis.' : 'Koordinaten sind deaktiviert.' });
      embed.setTimestamp(args.generatedAt ?? new Date());
    }
    embeds.push(embed);
  }
  return embeds.slice(0, 10);
}
