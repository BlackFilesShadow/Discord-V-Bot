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

function parseHex(value: string): number {
  const raw = value.startsWith('#') ? value.slice(1) : value;
  const parsed = Number.parseInt(raw, 16);
  return Number.isNaN(parsed) ? 0xdc2626 : parsed;
}

function safeName(value: string): string {
  return safeEmbedField(value.replace(/`/g, 'ˋ'), 256);
}

function rawPosition(value: string | null): string | null {
  if (!value) return null;
  const clean = value.replace(/[<>]/g, '').trim();
  if (!clean || clean.length > 128) return null;
  return safeEmbedField(clean, 128);
}

export function gameplayEventMarker(eventId: string): string {
  return `V-Bot event:${eventId}`;
}

export function buildGameplayFeedEmbed(
  view: GameplayFeedView,
  embedColor: string,
  serverAlias: string,
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(parseHex(embedColor))
    .setTitle(TITLES[view.category])
    .setFooter({ text: `${gameplayEventMarker(view.eventId)} • ${safeEmbedField(serverAlias || 'Gameserver', 80)}` });

  if (view.occurredAt) embed.setTimestamp(view.occurredAt);

  if (view.kind === 'DEATH') {
    embed.addFields({ name: 'Opfer', value: `\`${safeName(view.actorName)}\``, inline: true });
    if (view.targetName) {
      const label = view.category === 'PVP' ? 'Töter' : 'Ursache';
      embed.addFields({ name: label, value: `\`${safeName(view.targetName)}\``, inline: true });
    }
    if (view.toolOrWeapon) {
      embed.addFields({ name: view.category === 'VEHICLE' ? 'Fahrzeug / Ursache' : 'Waffe', value: safeEmbedField(view.toolOrWeapon, 256), inline: true });
    }
    if (typeof view.distanceMeters === 'number' && Number.isFinite(view.distanceMeters)) {
      embed.addFields({ name: 'Distanz', value: `${view.distanceMeters} m`, inline: true });
    }
    const victimPos = rawPosition(view.actorPosition);
    if (victimPos) embed.addFields({ name: 'Opfer-Position', value: victimPos, inline: true });
    const killerPos = rawPosition(view.targetPosition);
    if (killerPos) embed.addFields({ name: 'Töter-Position', value: killerPos, inline: true });
    return embed;
  }

  embed.addFields({ name: 'Spieler', value: `\`${safeName(view.actorName)}\``, inline: true });
  if (view.objectType) {
    embed.addFields({ name: 'Objekt', value: safeEmbedField(view.objectType, 256), inline: true });
  }
  if (view.toolOrWeapon) {
    embed.addFields({ name: 'Werkzeug', value: safeEmbedField(view.toolOrWeapon, 256), inline: true });
  }
  const pos = rawPosition(view.actorPosition);
  if (pos) embed.addFields({ name: 'Position', value: pos, inline: true });
  return embed;
}
