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
 * Erstellt ein gebrandetes Embed mit konsistentem Styling.
 */
export function vEmbed(color: number = Colors.Primary): EmbedBuilder {
  return new EmbedBuilder()
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
