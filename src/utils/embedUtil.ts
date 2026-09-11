import { EmbedBuilder, ColorResolvable } from 'discord.js';
import {
  safeEmbedTitle,
  safeEmbedDescription,
  safeEmbedField,
  safeEmbedFooter,
} from './embedSanitize';
import {
  compactDescription,
  compactEmbed,
  readableEmbedDescription,
  statusForColor,
  statusTitle,
} from './embedDesign';

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
  sanitize?: boolean;
}

const DEFAULT_COLOR: ColorResolvable = '#5865F2';
const DEFAULT_FOOTER = 'Discord V Bot • © 2026';

function colorNumber(color: ColorResolvable | undefined): number | null {
  if (typeof color === 'number') return color;
  if (typeof color !== 'string') return null;
  const match = /^#?([0-9a-fA-F]{6})$/.exec(color.trim());
  return match ? parseInt(match[1], 16) : null;
}

export function createBotEmbed(options: EmbedOptions = {}): EmbedBuilder {
  const sanitize = options.sanitize !== false;
  const color = options.color || DEFAULT_COLOR;
  const numericColor = colorNumber(color);
  const footerText = sanitize
    ? safeEmbedFooter(options.footer || DEFAULT_FOOTER)
    : (options.footer || DEFAULT_FOOTER);
  const embed = numericColor === null
    ? new EmbedBuilder().setColor(color).setFooter({ text: footerText })
    : compactEmbed(numericColor, footerText);

  let title: string | undefined;
  if (options.title) {
    title = sanitize ? safeEmbedTitle(options.title) : options.title;
    const status = numericColor === null ? null : statusForColor(numericColor);
    if (status) title = statusTitle(status, title);
  }
  const description = options.description
    ? readableEmbedDescription(sanitize ? safeEmbedDescription(options.description) : options.description)
    : undefined;

  if (title) embed.setDescription(compactDescription(title, [description]));
  else if (description) embed.setDescription(description);

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
