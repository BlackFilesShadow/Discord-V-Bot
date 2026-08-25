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
      // Bewusst direkt nach dem Server-Alias und als eigene Zeile. So steht die
      // Ereigniszeit weder ueber noch neben dem Servernamen.
      embed.addFields({ name: 'Ereigniszeit', value: timestamp, inline: false });
    }
  }
}

function humanizePlacementClass(value: string): string {
  const raw = value.trim();
  if (!raw) return 'Objekt';

  // Die sichtbare Bezeichnung soll spielerfreundlich bleiben. Bekannte
  // DayZ-Kategorien koennen dabei gezielt lokalisiert werden; unbekannte
  // Classnames werden nur lesbar getrennt und niemals verworfen.
  if (/^GardenPlot$/i.test(raw)) return 'Gartenplot';

  const readable = raw
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
  return readable || raw;
}

/**
 * DayZ schreibt bei Placement-Aktionen teilweise sowohl einen Anzeigenamen als
 * auch den technischen Classname, z.B. `Snare Trap<RabbitSnareTrap>`. Fuer den
 * Discord-Report reicht der Anzeigename. Bei `Nameless Object<...>` ist der
 * Classname dagegen die einzige brauchbare Kategorie und wird sichtbar erhalten.
 * Die gespeicherten ADM-Rohdaten werden dadurch nicht veraendert.
 */
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
    // Die offizielle DayZ-ADM-Suizidzeile nennt die verwendete Waffe nicht
    // zwingend. Das Feld bleibt im abgestimmten Layout sichtbar und erfindet
    // bei fehlender ADM-Evidenz bewusst keinen Wert.
    embed.addFields({
      name: 'Waffe',
      value: safeEmbedField(view.toolOrWeapon ?? 'Nicht durch ADM ermittelbar', 256),
      inline: false,
    });
    const pos = positionField(view.actorPosition);
    if (pos) embed.addFields({ name: 'Pos:', value: pos, inline: false });
    addServer(embed, serverAlias);
    return embed;
  }

  if (view.category === 'NPC') {
    embed.addFields({ name: 'Opfer', value: safeName(view.actorName), inline: false });
    if (view.targetName) {
      embed.addFields({ name: 'Ursache', value: safeName(view.targetName), inline: false });
    }
    const pos = positionField(view.actorPosition);
    if (pos) embed.addFields({ name: 'Pos:', value: pos, inline: false });
    addServer(embed, serverAlias);
    return embed;
  }

  if (view.category === 'VEHICLE') {
    embed.addFields({ name: 'Opfer', value: safeName(view.actorName), inline: false });
    if (view.targetName) {
      embed.addFields({ name: 'Fahrzeug / Ursache', value: safeName(view.targetName), inline: false });
    }
    const pos = positionField(view.actorPosition);
    if (pos) embed.addFields({ name: 'Pos:', value: pos, inline: false });
    addServer(embed, serverAlias);
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
  // Der Death-/Killfeed bleibt bewusst ohne Ereigniszeit. Alle anderen
  // ereignisbasierten Nitrado-Gameplay-Feeds zeigen sie direkt unter dem Alias.
  addServer(embed, serverAlias, view.occurredAt, true);
  return embed;
}
