import { EmbedBuilder } from 'discord.js';
import { safeEmbedField } from '../../utils/embedSanitize';
import type { GameplayFeedView } from './types';

const TITLES: Record<GameplayFeedView['category'], string> = {
  PVP: '💀 V-Kill Report',
  SUICIDE: '🩸 Self Kill Report',
  NPC: '☣️ Wild Kill Report',
  VEHICLE: '💥 Crash Kill Report',
  PLACEMENT: '📦 Placement Report',
  BUILD: '🔨 Build Report',
  DISMANTLE: '🔧 Dismantle Report',
  DESTROY: '💥 Destruction Report',
  RAISED: '🚩 Flagge hochgezogen',
  LOWERED: '🏳️ Flagge heruntergelassen',
};

const IZURVIVE_BASE_URL = 'https://www.izurvive.com/';
const IZURVIVE_ZOOM = 6;

function parseHex(value: string): number {
  const raw = value.startsWith('#') ? value.slice(1) : value;
  const parsed = Number.parseInt(raw, 16);
  return Number.isNaN(parsed) ? 0xdc2626 : parsed;
}

function safeName(value: string): string {
  return safeEmbedField(value.replace(/`/g, 'ˋ'), 256);
}

function cleanPosition(value: string | null): string | null {
  if (!value) return null;
  const clean = value.replace(/[<>]/g, '').trim();
  if (!clean || clean.length > 128) return null;
  return clean;
}

/**
 * iZurvive dokumentiert Location-Deep-Links als #location=x;y;zoomlevel.
 * Der Link setzt dort einen temporaeren Positionsmarker, ohne dass der Bot
 * selbst Kartenbilder rendern oder externe Marker speichern muss.
 */
export function izurvivePositionUrl(value: string | null): string | null {
  const clean = cleanPosition(value);
  if (!clean) return null;
  const parts = clean.split(',').map(part => part.trim());
  if (parts.length < 2) return null;
  const x = Number(parts[0]);
  const y = Number(parts[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return `${IZURVIVE_BASE_URL}#location=${x};${y};${IZURVIVE_ZOOM}`;
}

function positionField(value: string | null): string | null {
  const clean = cleanPosition(value);
  if (!clean) return null;
  const display = safeEmbedField(clean, 128);
  const url = izurvivePositionUrl(clean);
  return url ? `[${display}](${url})` : display;
}

function plainPositionField(value: string | null): string | null {
  const clean = cleanPosition(value);
  return clean ? safeEmbedField(clean, 128) : null;
}

function personWithPosition(name: string, position: string | null): string {
  const safe = safeName(name);
  const pos = positionField(position);
  return pos ? `${safe}\nPos: ${pos}` : safe;
}

function eventTimeField(occurredAt: Date | null): string | null {
  if (!occurredAt || Number.isNaN(occurredAt.getTime())) return null;
  return `<t:${Math.floor(occurredAt.getTime() / 1000)}:F>`;
}

function addServer(
  embed: EmbedBuilder,
  serverAlias: string,
  occurredAt: Date | null = null,
  showEventTime = false,
): void {
  embed.addFields({
    name: 'Server',
    value: safeEmbedField(serverAlias.trim() || 'DayZ-Server', 256),
    inline: false,
  });
  if (showEventTime) {
    const timestamp = eventTimeField(occurredAt);
    if (timestamp) {
      embed.addFields({ name: 'Ereigniszeit', value: timestamp, inline: false });
    }
  }
}

function humanizePlacementClass(value: string): string {
  const raw = value.trim();
  if (!raw) return 'Objekt';
  if (/^GardenPlot$/i.test(raw)) return 'Gartenplot';

  const readable = raw
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
  return readable || raw;
}

export function placementObjectLabel(value: string): string {
  const raw = value.trim();
  const wrapped = /^(.+?)\s*<([^<>]+)>\s*$/.exec(raw);
  if (!wrapped) return raw;

  const displayName = wrapped[1].trim();
  const className = wrapped[2].trim();
  if (/^Nameless(?:\s+Object)?$/i.test(displayName)) {
    return `Nameless ${humanizePlacementClass(className)}`;
  }
  return displayName || humanizePlacementClass(className);
}

export function buildGameplayFeedEmbed(
  view: GameplayFeedView,
  embedColor: string,
  serverAlias: string,
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(parseHex(embedColor))
    .setTitle(TITLES[view.category]);

  if (view.kind === 'FLAG') {
    addServer(embed, serverAlias, view.occurredAt, true);
    embed.addFields({ name: 'Spieler', value: safeName(view.actorName), inline: false });
    if (view.objectType) {
      embed.addFields({ name: 'Flagge', value: safeEmbedField(view.objectType, 256), inline: false });
    }
    const flagPos = plainPositionField(view.targetPosition);
    if (flagPos) embed.addFields({ name: 'Flaggen-Koordinaten', value: flagPos, inline: false });
    const actorPos = plainPositionField(view.actorPosition);
    if (actorPos) embed.addFields({ name: 'Spieler-Koordinaten', value: actorPos, inline: false });
    return embed;
  }

  if (view.category === 'PVP') {
    embed.addFields({
      name: 'Killer',
      value: personWithPosition(view.targetName ?? 'Unbekannt', view.targetPosition),
      inline: false,
    });
    embed.addFields({
      name: 'Opfer',
      value: personWithPosition(view.actorName, view.actorPosition),
      inline: false,
    });
    embed.addFields({
      name: 'Waffe',
      value: safeEmbedField(view.toolOrWeapon ?? 'Nicht ermittelbar', 256),
      inline: false,
    });
    if (typeof view.distanceMeters === 'number' && Number.isFinite(view.distanceMeters)) {
      embed.addFields({ name: 'Distanz', value: `${view.distanceMeters} m`, inline: false });
    }
    addServer(embed, serverAlias);
    return embed;
  }

  if (view.category === 'SUICIDE') {
    embed.addFields({ name: 'Spieler', value: safeName(view.actorName), inline: false });
    embed.addFields({
      name: 'Waffe',
      value: safeEmbedField(view.toolOrWeapon ?? 'Nicht durch ADM ermittelbar', 256),
      inline: false,
    });
    const pos = positionField(view.actorPosition);
    if (pos) embed.addFields({ name: 'Pos:', value: pos, inline: false });
    addServer(embed, serverAlias, view.occurredAt, true);
    return embed;
  }

  if (view.category === 'NPC') {
    embed.addFields({ name: 'Opfer', value: safeName(view.actorName), inline: false });
    if (view.targetName) {
      embed.addFields({ name: 'Ursache', value: safeName(view.targetName), inline: false });
    }
    const pos = positionField(view.actorPosition);
    if (pos) embed.addFields({ name: 'Pos:', value: pos, inline: false });
    addServer(embed, serverAlias, view.occurredAt, true);
    return embed;
  }

  if (view.category === 'VEHICLE') {
    embed.addFields({ name: 'Opfer', value: safeName(view.actorName), inline: false });
    if (view.targetName) {
      embed.addFields({ name: 'Fahrzeug / Ursache', value: safeName(view.targetName), inline: false });
    }
    const pos = positionField(view.actorPosition);
    if (pos) embed.addFields({ name: 'Pos:', value: pos, inline: false });
    addServer(embed, serverAlias, view.occurredAt, true);
    return embed;
  }

  embed.addFields({ name: 'Spieler', value: safeName(view.actorName), inline: false });
  if (view.objectType) {
    const objectLabel = view.category === 'PLACEMENT'
      ? placementObjectLabel(view.objectType)
      : view.objectType;
    embed.addFields({ name: 'Objekt', value: safeEmbedField(objectLabel, 256), inline: false });
  }
  if (view.toolOrWeapon) {
    embed.addFields({ name: 'Werkzeug', value: safeEmbedField(view.toolOrWeapon, 256), inline: false });
  }
  const pos = positionField(view.actorPosition);
  if (pos) embed.addFields({ name: 'Position', value: pos, inline: false });
  addServer(embed, serverAlias, view.occurredAt, true);
  return embed;
}
