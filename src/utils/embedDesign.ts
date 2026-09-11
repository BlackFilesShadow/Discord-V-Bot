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
const EMBED_DESCRIPTION_LIMIT = 4096;
const EMBED_HEADING_LIMIT = 256;

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

export function readableEmbedDescription(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function capCompactDescription(value: string): string {
  if (value.length <= EMBED_DESCRIPTION_LIMIT) return value;
  return `${value.slice(0, EMBED_DESCRIPTION_LIMIT - 1)}…`;
}

function markdownLinkLabel(value: string): string {
  return value.replace(/([\\\[\]])/g, '\\$1');
}

function markdownLinkUrl(value: string): string {
  return value
    .replace(/\\/g, '%5C')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29');
}

/**
 * Systemweite feste V-Bot-Embeds verwenden dieselbe kompakte Form wie die
 * freigegebenen Referenzen. Bestehende Aufrufer duerfen weiterhin setTitle()
 * verwenden; der Builder praesentiert diesen Titel nur noch als fette erste
 * Description-Zeile. Fachlogik, Fields, Komponenten und Sichtbarkeit bleiben
 * dadurch unveraendert.
 *
 * Dashboard-/Webhook-Custom-Embeds nutzen bewusst rohe EmbedBuilder-Instanzen
 * und bleiben deshalb frei gestaltbar.
 */
class VEmbedBuilder extends EmbedBuilder {
  private presentationHeading: string | null = null;
  private presentationBody: string | null = null;
  private presentationUrl: string | null = null;

  constructor(private readonly status: EmbedStatus | null) {
    super();
  }

  private renderPresentation(): this {
    let heading = this.presentationHeading;
    if (heading && this.presentationUrl) {
      heading = `[${markdownLinkLabel(heading)}](${markdownLinkUrl(this.presentationUrl)})`;
    }

    if (!heading && !this.presentationBody) {
      super.setDescription(null);
      return this;
    }

    const description = heading
      ? compactDescription(heading, [this.presentationBody])
      : readableEmbedDescription(this.presentationBody ?? '');
    super.setDescription(capCompactDescription(description));
    return this;
  }

  override setTitle(title: string | null): this {
    if (title === null) {
      this.presentationHeading = null;
      return this.renderPresentation();
    }
    const formatted = this.status ? statusTitle(this.status, title) : title.trim();
    this.presentationHeading = formatted.slice(0, EMBED_HEADING_LIMIT);
    return this.renderPresentation();
  }

  override setDescription(description: string | null): this {
    this.presentationBody = description === null ? null : readableEmbedDescription(description);
    return this.renderPresentation();
  }

  override setURL(url: string | null): this {
    this.presentationUrl = url;
    if (this.presentationHeading) {
      // Ein klassischer Embed-URL-Link haengt am nativen Discord-Titel. Da
      // feste V-Bot-Titel kompakt in der Description liegen, bleibt die URL
      // als Markdown-Link auf exakt dieser Kopfzeile klickbar.
      super.setURL(null);
      return this.renderPresentation();
    }
    return super.setURL(url);
  }
}

/**
 * Einheitliche V-Bot-Basis. Ein Zeitstempel wird nicht mehr automatisch
 * erzwungen; Oberflaechen, fuer die Zeit fachlich relevant ist, setzen ihn
 * weiterhin explizit selbst.
 */
export function vEmbed(color: number = Colors.Primary): EmbedBuilder {
  return new VEmbedBuilder(statusForColor(color))
    .setColor(color)
    .setFooter({ text: Brand.footerText });
}

/**
 * Kompakte V-Bot-Embed-Basis fuer die neue einheitliche Discord-Optik.
 * Bewusst reine Praesentationsschicht: keine Interaktions-, Daten- oder
 * Berechtigungslogik wird hier abgebildet.
 */
export function compactEmbed(
  color: number = Colors.Primary,
  footerText: string = Brand.footerText,
): EmbedBuilder {
  return vEmbed(color).setFooter({ text: footerText });
}

export function economyEmbed(
  color: number = Colors.Primary,
  footerText: string = 'V-Bot • Economy',
): EmbedBuilder {
  return compactEmbed(color, footerText);
}

export function casinoEmbed(
  color: number = Colors.Primary,
  footerText: string = 'V-Bot • Casino',
): EmbedBuilder {
  return compactEmbed(color, footerText);
}

/**
 * Erzeugt die in den Referenz-Embeds verwendete kompakte Struktur:
 * fette Kopfzeile, danach kurze Inhaltszeilen ohne kuenstliche Trenner.
 */
export function compactDescription(
  heading: string,
  lines: readonly (string | null | undefined | false)[] = [],
): string {
  const body = lines
    .filter((line): line is string => typeof line === 'string' && line.trim().length > 0)
    .map(line => line.trim());
  const cleanHeading = heading.trim();
  return capCompactDescription(readableEmbedDescription([
    cleanHeading ? `**${cleanHeading}**` : '',
    ...body,
  ].filter(Boolean).join('\n')));
}

/** Discord-Blockquote fuer kompakte Wertelisten wie Balance/Bank. */
export function compactQuote(lines: readonly string[]): string {
  return lines
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => `> ${line}`)
    .join('\n');
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
