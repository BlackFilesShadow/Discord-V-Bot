import { EmbedBuilder, ColorResolvable } from 'discord.js';

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
}

const DEFAULT_COLOR: ColorResolvable = '#5865F2'; // Discord Blurple
const DEFAULT_FOOTER = 'Discord V Bot • © 2026';

export function createBotEmbed(options: EmbedOptions = {}): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(options.color || DEFAULT_COLOR)
    .setFooter({ text: options.footer || DEFAULT_FOOTER });

  if (options.title) embed.setTitle(options.title);
  if (options.description) embed.setDescription(options.description);
  if (options.fields) embed.addFields(options.fields);
  if (options.thumbnail) embed.setThumbnail(options.thumbnail);
  if (options.image) embed.setImage(options.image);
  if (options.url) embed.setURL(options.url);
  if (options.timestamp) embed.setTimestamp();

  return embed;
}
