import { EmbedBuilder, ColorResolvable } from 'discord.js';
import {
  safeEmbedTitle,
  safeEmbedDescription,
  safeEmbedField,
  safeEmbedFooter,
} from './embedSanitize';

interface EmbedOptions {
  title?: string;
  description?: string;
  color?: ColorResolvable;
  fields?: { name: string; value: string; inline?: boolean }[];
  footer?: string;
  thumbnail?: string;
  image?: string;
  url?: string;
  timestamp?: boolean;
  /**
   * P0-Hardening: Wenn true (oder unset), werden alle textuellen Felder durch
   * embedSanitize-Helper geschickt (Markdown-Escape + Length-Cap). Nur explizit
   * `false` setzen, wenn Bot-konstanter Markdown gewollt ist.
   */
  sanitize?: boolean;
}

const DEFAULT_COLOR: ColorResolvable = '#5865F2'; // Discord Blurple
const DEFAULT_FOOTER = 'Discord V Bot • © 2026';

export function createBotEmbed(options: EmbedOptions = {}): EmbedBuilder {
  const sanitize = options.sanitize !== false;
  const embed = new EmbedBuilder()
    .setColor(options.color || DEFAULT_COLOR)
    .setFooter({
      text: sanitize ? safeEmbedFooter(options.footer || DEFAULT_FOOTER) : (options.footer || DEFAULT_FOOTER),
    });

  if (options.title) embed.setTitle(sanitize ? safeEmbedTitle(options.title) : options.title);
  if (options.description) embed.setDescription(sanitize ? safeEmbedDescription(options.description) : options.description);
  if (options.fields) {
    embed.addFields(
      sanitize
        ? options.fields.map(f => ({
            name: safeEmbedField(f.name, 256),
            value: safeEmbedField(f.value),
            inline: f.inline,
          }))
        : options.fields,
    );
  }
  if (options.thumbnail) embed.setThumbnail(options.thumbnail);
  if (options.image) embed.setImage(options.image);
  if (options.url) embed.setURL(options.url);
  if (options.timestamp) embed.setTimestamp();

  return embed;
}

