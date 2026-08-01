/**
 * Killfeed-Embed-Builder.
 *
 * Baut Discord-Embeds fuer Kill-Events. Toggles aus KillfeedConfig
 * entscheiden welche Felder eingeblendet werden.
 */

import { EmbedBuilder } from 'discord.js';
import type { KillEvent } from './admKillParser';
import { safeEmbedField } from '../../utils/embedSanitize';

export interface KillfeedEmbedToggles {
  showShooterCoords: boolean;
  showVictimCoords: boolean;
  showWeapon: boolean;
  showDistance: boolean;
  embedColor: string;
}

const TITLES: Record<KillEvent['category'], string> = {
  DEATH: 'PvP-Kill',
  SUICIDE: 'Selbstmord',
  NPC: 'NPC-Tod',
  VEHICLE: 'Fahrzeug-Tod',
};

function parseHex(hex: string): number {
  const h = hex.startsWith('#') ? hex.slice(1) : hex;
  const n = Number.parseInt(h, 16);
  return Number.isNaN(n) ? 0xdc2626 : n;
}

function fmtPos(pos?: string): string | null {
  if (!pos) return null;
  // "<1234.5,6789.0,123.4>" oder "1234.5,6789.0,123.4"
  const clean = pos.replace(/[<>]/g, '').trim();
  const parts = clean.split(',').map(p => Number(p.trim()));
  if (parts.length < 2 || parts.some(Number.isNaN)) return null;
  return `${Math.round(parts[0])} / ${Math.round(parts[1])}`;
}

export function buildKillfeedEmbed(ev: KillEvent, t: KillfeedEmbedToggles): EmbedBuilder {
  const e = new EmbedBuilder()
    .setColor(parseHex(t.embedColor))
    .setTitle(TITLES[ev.category])
    .setTimestamp(ev.occurredAt);

  e.addFields({ name: 'Opfer', value: `\`${ev.victimName}\``, inline: true });
  if (ev.shooterName) {
    e.addFields({ name: ev.category === 'NPC' ? 'Verursacher' : 'Toeter', value: `\`${ev.shooterName}\``, inline: true });
  }

  if (t.showWeapon && ev.weapon) {
    e.addFields({ name: 'Waffe', value: safeEmbedField(ev.weapon, 256), inline: true });
  }
  if (t.showDistance && typeof ev.distance === 'number') {
    e.addFields({ name: 'Distanz', value: `${ev.distance.toFixed(1)} m`, inline: true });
  }
  if (t.showVictimCoords) {
    const p = fmtPos(ev.victimPos);
    if (p) e.addFields({ name: 'Opfer-Pos', value: p, inline: true });
  }
  if (t.showShooterCoords) {
    const p = fmtPos(ev.shooterPos);
    if (p) e.addFields({ name: 'Toeter-Pos', value: p, inline: true });
  }

  return e;
}

// ============================================================
// Killfeed V2 (Phase 6) — Embed aus normalisiertem AdmEvent-View.
// KILL-COORD: exakte X/Y/Z-Rohwerte OHNE Rundung.
// ============================================================
import type { KillfeedView, KillCategoryV2 } from './killfeedV2';

const TITLES_V2: Record<KillCategoryV2, string> = {
  DEATH: 'PvP-Kill',
  SUICIDE: 'Selbstmord',
  NPC: 'NPC-Tod',
  VEHICLE: 'Fahrzeug-Tod',
};

/** Rohkoordinaten: nur Klammern entfernen, KEINE Rundung (KILL-COORD). */
function rawPos(pos: string | null): string | null {
  if (!pos) return null;
  const clean = pos.replace(/[<>]/g, '').trim();
  return clean.length > 0 ? clean : null;
}

export function buildKillfeedEmbedV2(view: KillfeedView, embedColor: string): EmbedBuilder {
  const e = new EmbedBuilder()
    .setColor(parseHex(embedColor))
    .setTitle(TITLES_V2[view.category])
    .setTimestamp(view.occurredAt ?? null);

  e.addFields({ name: 'Opfer', value: `\`${view.victimName}\``, inline: true });
  if (view.killerName) {
    e.addFields({ name: view.category === 'NPC' ? 'Verursacher' : 'Toeter', value: `\`${view.killerName}\``, inline: true });
  }
  if (view.weapon) {
    e.addFields({ name: 'Waffe', value: safeEmbedField(view.weapon, 256), inline: true });
  }
  if (typeof view.distanceMeters === 'number') {
    e.addFields({ name: 'Distanz', value: `${view.distanceMeters} m`, inline: true });
  }
  const vp = rawPos(view.victimPos);
  if (vp) e.addFields({ name: 'Opfer-Pos', value: vp, inline: true });
  const kp = rawPos(view.killerPos);
  if (kp) e.addFields({ name: 'Toeter-Pos', value: kp, inline: true });

  return e;
}
