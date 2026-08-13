import { EmbedBuilder } from 'discord.js';
import { Colors } from './embedDesign';

/**
 * Zentraler Status-Embed-Builder (Embed-Plan Rev IV, §9.2).
 *
 * Verbindliche Zuordnung:
 *   SUCCESS -> ✅ + Gruen
 *   INFO    -> ❕ + Blau
 *   ERROR   -> ❌ + Rot
 *
 * Thematische Emojis im Titel bleiben erhalten.
 */

export type EmbedStatus = 'SUCCESS' | 'INFO' | 'ERROR';

const STATUS_META: Record<EmbedStatus, { emoji: string; color: number }> = {
  SUCCESS: { emoji: '✅', color: Colors.Success },
  INFO: { emoji: '❕', color: Colors.Info },
  ERROR: { emoji: '❌', color: Colors.Error },
};

const LEADING_STATUS_RE = /^(?:✅|❌|❕|ℹ️|ℹ)\s*/u;

export interface StatusEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface StatusEmbedOptions {
  status: EmbedStatus;
  title: string;
  description?: string;
  fields?: StatusEmbedField[];
  footerText?: string;
}

function cap(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(1, max - 1))}…`;
}

export function statusEmoji(status: EmbedStatus): string {
  return STATUS_META[status].emoji;
}

export function statusColor(status: EmbedStatus): number {
  return STATUS_META[status].color;
}

function cleanTitle(status: EmbedStatus, title: string): string {
  const clean = title.trim().replace(LEADING_STATUS_RE, '').trim();
  return clean ? `${STATUS_META[status].emoji} ${clean}` : STATUS_META[status].emoji;
}

export function buildStatusEmbed(opts: StatusEmbedOptions): EmbedBuilder {
  const meta = STATUS_META[opts.status];
  const embed = new EmbedBuilder()
    .setColor(meta.color)
    .setTitle(cap(cleanTitle(opts.status, opts.title), 256))
    .setFooter({ text: cap(opts.footerText ?? 'V-Bot', 2048) })
    .setTimestamp();

  if (opts.description) embed.setDescription(cap(opts.description, 4096));

  if (opts.fields?.length) {
    embed.addFields(
      opts.fields.slice(0, 25).map((f) => ({
        name: cap(f.name, 256),
        value: cap(f.value.length ? f.value : '\u200B', 1024),
        inline: f.inline ?? false,
      })),
    );
  }

  return embed;
}
