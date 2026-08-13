import { EmbedBuilder } from 'discord.js';

// ═══════════════════════════════════════════
// V-Bot — Embed Design-System
// Konsistentes, professionelles Embed-Design
// ═══════════════════════════════════════════

/** Farbpalette für alle Embeds */
export const Colors = {
  Primary:    0x5865F2,  // Discord Blurple
  Success:    0x57F287,  // Grün
  Error:      0xED4245,  // Rot
  Warning:    0xFEE75C,  // Gelb/Amber
  Info:       0x3498DB,  // Blau
  Giveaway:   0xEB459E,  // Fuchsia/Pink
  Gold:       0xF1C40F,  // Gold (Level/XP)
  Dev:        0x9B59B6,  // Lila (Developer)
  Admin:      0xE67E22,  // Orange (Admin)
  Neutral:    0x99AAB5,  // Grau (beendet/inaktiv)
  Upload:     0x2ECC71,  // Smaragdgrün
  Download:   0x3498DB,  // Blau
  Moderation: 0xE74C3C,  // Dunkelrot
  Poll:       0x9B59B6,  // Lila
  Teal:       0x1ABC9C,  // Teal
} as const;

/** Branding-Texte */
export const Brand = {
  name: 'V-Bot',
  footerText: 'V-Bot',
  divider: '━━━━━━━━━━━━━━━━━━━━━━━━━━━',
  shortDivider: '───────────────',
  dot: '•',
} as const;

/**
 * Verbindliche Status-Sprache fuer feste V-Bot-Embeds.
 * Thematische Emojis bleiben erhalten; das Statussymbol steht nur davor.
 */
export type EmbedStatus = 'SUCCESS' | 'INFO' | 'ERROR' | 'WARNING' | 'NEUTRAL';
export type StatusIcon = '✅' | '❕' | '❌' | '⚠️';

export const StatusIcons: Record<Exclude<EmbedStatus, 'NEUTRAL'>, StatusIcon> = {
  SUCCESS: '✅',
  INFO: '❕',
  ERROR: '❌',
  WARNING: '⚠️',
} as const;

const LEADING_STATUS_RE = /^(?:✅|❌|❕|⚠️|⚠|ℹ️|ℹ)\s*/u;

/**
 * Setzt exakt EIN Statussymbol vor einen Titel.
 * Thematische Emojis wie 🎫, 📋, 🤖 oder 📦 bleiben unangetastet.
 */
export function statusTitle(status: EmbedStatus, title: string): string {
  const trimmed = title.trim();
  if (status === 'NEUTRAL') return trimmed;

  const icon = StatusIcons[status];
  const withoutOldStatus = trimmed.replace(LEADING_STATUS_RE, '').trim();
  return withoutOldStatus ? `${icon} ${withoutOldStatus}` : icon;
}

/** Status anhand der zentralen Statusfarbe. Andere Modulfarben bleiben neutral. */
export function statusForColor(color: number): EmbedStatus | null {
  if (color === Colors.Success) return 'SUCCESS';
  if (color === Colors.Error) return 'ERROR';
  if (color === Colors.Info) return 'INFO';
  if (color === Colors.Warning) return 'WARNING';
  return null;
}

/**
 * EmbedBuilder, der bei bekannten Statusfarben die Titel automatisch normiert.
 * Bestehende thematische Emojis und der restliche Titel bleiben erhalten.
 */
class VEmbedBuilder extends EmbedBuilder {
  constructor(private readonly status: EmbedStatus | null) {
    super();
  }

  override setTitle(title: string): this {
    return super.setTitle(this.status ? statusTitle(this.status, title) : title);
  }
}

/**
 * Erstellt ein gebrandetes Embed mit konsistentem Styling.
 * Success -> ✅, Info -> ❕, Error -> ❌, Warning -> ⚠️.
 * Andere Modulfarben (Gold, Poll, Giveaway, Admin, Dev usw.) bleiben unverändert.
 */
export function vEmbed(color: number = Colors.Primary): EmbedBuilder {
  return new VEmbedBuilder(statusForColor(color))
    .setColor(color)
    .setFooter({ text: Brand.footerText })
    .setTimestamp();
}

/**
 * Fortschrittsbalken mit modernem Design.
 */
export function progressBar(current: number, max: number, length: number = 12): string {
  const pct = max > 0 ? Math.min(current / max, 1) : 0;
  const filled = Math.round(pct * length);
  return '▓'.repeat(filled) + '░'.repeat(length - filled);
}

/**
 * Prozentanzeige mit Balken.
 */
export function percentBar(percentage: number, length: number = 12): string {
  const filled = Math.round((percentage / 100) * length);
  return '▓'.repeat(filled) + '░'.repeat(length - filled);
}

/**
 * Formatiert Bytes in lesbare Größe.
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

/**
 * Status-Badge für Embed-Felder.
 */
export function statusBadge(active: boolean): string {
  return active ? '`🟢 Aktiv`' : '`🔴 Inaktiv`';
}
