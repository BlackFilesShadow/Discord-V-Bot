import { EmbedBuilder } from 'discord.js';

// ═══════════════════════════════════════════
// V-Bot Prime — Embed Design-System
// Konsistentes, professionelles Embed-Design
// ═══════════════════════════════════════════

/** Farbpalette für alle Embeds */
export const Colors = {
  Primary:    0x5865F2,
  Success:    0x57F287,
  Error:      0xED4245,
  Warning:    0xFEE75C,
  Info:       0x3498DB,
  Giveaway:   0xEB459E,
  Gold:       0xF1C40F,
  Dev:        0x9B59B6,
  Admin:      0xE67E22,
  Neutral:    0x99AAB5,
  Upload:     0x2ECC71,
  Download:   0x3498DB,
  Moderation: 0xE74C3C,
  Poll:       0x9B59B6,
  Teal:       0x1ABC9C,
} as const;

/** Branding-Texte */
export const Brand = {
  name: 'V-Bot Prime',
  footerText: 'V-Bot Prime',
  divider: '━━━━━━━━━━━━━━━━━━━━━━━━━━━',
  shortDivider: '───────────────',
  dot: '•',
} as const;

/** Verbindliche Status-Sprache fuer feste V-Bot-Prime-Embeds. */
export type EmbedStatus = 'SUCCESS' | 'INFO' | 'ERROR' | 'WARNING' | 'NEUTRAL';
export type StatusIcon = '✅' | '❕' | '❌' | '⚠️';

export const StatusIcons: Record<Exclude<EmbedStatus, 'NEUTRAL'>, StatusIcon> = {
  SUCCESS: '✅',
  INFO: '❕',
  ERROR: '❌',
  WARNING: '⚠️',
} as const;

const LEADING_STATUS_RE = /^(?:✅|❌|❕|⚠️|⚠|ℹ️|ℹ)\s*/u;

export function statusTitle(status: EmbedStatus, title: string): string {
  const trimmed = title.trim();
  if (status === 'NEUTRAL') return trimmed;

  const icon = StatusIcons[status];
  const withoutOldStatus = trimmed.replace(LEADING_STATUS_RE, '').trim();
  return withoutOldStatus ? `${icon} ${withoutOldStatus}` : icon;
}

export function statusForColor(color: number): EmbedStatus | null {
  if (color === Colors.Success) return 'SUCCESS';
  if (color === Colors.Error) return 'ERROR';
  if (color === Colors.Info) return 'INFO';
  if (color === Colors.Warning) return 'WARNING';
  return null;
}

class VEmbedBuilder extends EmbedBuilder {
  constructor(private readonly status: EmbedStatus | null) {
    super();
  }

  override setTitle(title: string): this {
    return super.setTitle(this.status ? statusTitle(this.status, title) : title);
  }
}

export function vEmbed(color: number = Colors.Primary): EmbedBuilder {
  return new VEmbedBuilder(statusForColor(color))
    .setColor(color)
    .setFooter({ text: Brand.footerText })
    .setTimestamp();
}

export function progressBar(current: number, max: number, length: number = 12): string {
  const pct = max > 0 ? Math.min(current / max, 1) : 0;
  const filled = Math.round(pct * length);
  return '▓'.repeat(filled) + '░'.repeat(length - filled);
}

export function percentBar(percentage: number, length: number = 12): string {
  const filled = Math.round((percentage / 100) * length);
  return '▓'.repeat(filled) + '░'.repeat(length - filled);
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

export function statusBadge(active: boolean): string {
  return active ? '`🟢 Aktiv`' : '`🔴 Inaktiv`';
}
