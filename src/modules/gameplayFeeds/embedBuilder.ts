import { EmbedBuilder } from 'discord.js';
import { safeEmbedField } from '../../utils/embedSanitize';
import type { GameplayFeedView } from './types';

const TITLES: Record<GameplayFeedView['category'], string> = {
  PVP: '💀 PvP-Kill',
  DEATH: '☠️ Tod',
  SUICIDE: '🩸 Suizid',
  NPC: '🧟 NPC / Tier / Infizierter',
  VEHICLE: '🚗 Fahrzeug-Tod',
  PLACEMENT: '📦 Objekt platziert',
  BUILD: '🔨 Gebaut',
  DISMANTLE: '🧰 Demontiert',
  DESTROY: '💥 Zerstört',
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

export function buildGameplayFeedEmbed(
  view: GameplayFeedView,
  embedColor: string,
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(parseHex(embedColor))
    .setTitle(TITLES[view.category]);

  if (view.kind === 'DEATH') {
    // Kein Inline-Code: safeEmbedField escaped Markdown selbst, sodass z.B.
    // Void__Architect in Discord ohne sichtbare Backslashes erscheint.
    embed.addFields({ name: 'Opfer', value: safeName(view.actorName), inline: true });
    if (view.targetName) {
      const label = view.category === 'PVP' ? 'Töter' : 'Ursache';
      embed.addFields({ name: label, value: safeName(view.targetName), inline: true });
    }
    if (view.toolOrWeapon) {
      embed.addFields({ name: view.category === 'VEHICLE' ? 'Fahrzeug / Ursache' : 'Waffe', value: safeEmbedField(view.toolOrWeapon, 256), inline: true });
    }
    if (typeof view.distanceMeters === 'number' && Number.isFinite(view.distanceMeters)) {
      embed.addFields({ name: 'Distanz', value: `${view.distanceMeters} m`, inline: true });
    }
    const victimPos = positionField(view.actorPosition);
    if (victimPos) embed.addFields({ name: 'Opfer-Position', value: victimPos, inline: true });
    const killerPos = positionField(view.targetPosition);
    if (killerPos) embed.addFields({ name: 'Töter-Position', value: killerPos, inline: true });
    return embed;
  }

  embed.addFields({ name: 'Spieler', value: safeName(view.actorName), inline: true });
  if (view.objectType) {
    embed.addFields({ name: 'Objekt', value: safeEmbedField(view.objectType, 256), inline: true });
  }
  if (view.toolOrWeapon) {
    embed.addFields({ name: 'Werkzeug', value: safeEmbedField(view.toolOrWeapon, 256), inline: true });
  }
  const pos = positionField(view.actorPosition);
  if (pos) embed.addFields({ name: 'Position', value: pos, inline: true });
  return embed;
}
