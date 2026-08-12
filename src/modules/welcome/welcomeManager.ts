import * as path from 'node:path';
import { AttachmentBuilder, EmbedBuilder } from 'discord.js';
import prisma from '../../database/prisma';
import { renderTemplate } from '../ai/triggers';
import { safeSend } from '../../utils/safeSend';
import { Colors, vEmbed } from '../../utils/embedDesign';

/**
 * Welcome-System pro Guild (BotConfig key=`welcome:<guildId>`).
 *
 * Die Begruessung wird als Embed-Nachricht versendet (Text als Beschreibung,
 * optionales Bild im Embed). Es gibt ausschliesslich statische, selbst
 * erstellte Texte mit Platzhaltern ({user}, {mention}, {guild}, {count}) —
 * KEINE KI-generierten Begruessungen mehr.
 */

export interface WelcomeConfig {
  enabled: boolean;
  channelId: string;
  message: string;        // statischer Begruessungstext mit Platzhaltern
  mediaUrl?: string;      // optional JPG/PNG/GIF/WEBP (Bild) oder MP4/WEBM (Video)
  mode?: 'text';          // nur noch statischer Text (KI-Modus entfernt)
  mediaLayout?: 'image_first' | 'text_first'; // (Legacy; bei Embed steuert das Embed die Anordnung)
}

export const MAX_WELCOME_TEMPLATE_GRAPHEMES = 4000;
export const MAX_WELCOME_EMBED_LENGTH = 4096;

const KEY = (guildId: string) => `welcome:${guildId}`;

/**
 * Zaehlt sichtbare Unicode-Zeichen (Grapheme) statt UTF-16-Code-Units.
 * Damit wird z. B. ein Emoji wie 🎉 als ein Zeichen gezaehlt. Bei sehr alten
 * Laufzeiten ohne Intl.Segmenter faellt die Funktion auf Unicode-Codepoints zurueck.
 */
export function countWelcomeGraphemes(text: string): number {
  const Segmenter = (Intl as unknown as {
    Segmenter?: new (locale?: string | string[], options?: { granularity: 'grapheme' }) => {
      segment(input: string): Iterable<unknown>;
    };
  }).Segmenter;

  if (Segmenter) {
    return Array.from(new Segmenter('de', { granularity: 'grapheme' }).segment(text)).length;
  }
  return Array.from(text).length;
}

/**
 * Discord begrenzt die Embed-Beschreibung auf 4096 Zeichen. Hier wird bewusst
 * die finale, bereits gerenderte Zeichenkette geprueft. Sie wird NICHT mehr
 * still abgeschnitten, damit weder Text noch Emoji/Markdown zerstoert werden.
 */
export function assertWelcomeEmbedLength(text: string): void {
  if (text.length > MAX_WELCOME_EMBED_LENGTH) {
    throw new Error(
      `Gerenderte Willkommensnachricht ist zu lang (${text.length}/${MAX_WELCOME_EMBED_LENGTH} Discord-Zeichen). ` +
      'Bitte Text kuerzen oder Platzhalter reduzieren.',
    );
  }
}

export async function getWelcomeConfig(guildId: string): Promise<WelcomeConfig | null> {
  const cfg = await prisma.botConfig.findUnique({ where: { key: KEY(guildId) } });
  if (!cfg) return null;
  return cfg.value as unknown as WelcomeConfig;
}

export async function setWelcomeConfig(guildId: string, cfg: WelcomeConfig, updatedBy: string): Promise<void> {
  await prisma.botConfig.upsert({
    where: { key: KEY(guildId) },
    create: {
      key: KEY(guildId),
      value: cfg as unknown as object,
      category: 'welcome',
      description: `Welcome-Konfiguration f\u00fcr Guild ${guildId}`,
      updatedBy,
    },
    update: { value: cfg as unknown as object, updatedBy },
  });
}

export async function disableWelcome(guildId: string, updatedBy: string): Promise<void> {
  const existing = await getWelcomeConfig(guildId);
  if (!existing) return;
  await setWelcomeConfig(guildId, { ...existing, enabled: false }, updatedBy);
}

export function renderWelcomeMessage(message: string, vars: { user: string; mention: string; guild: string; memberCount: number }): string {
  // {user} = lesbarer Server-Anzeigename; {mention} = explizite Discord-Mention.
  // Ein separater Ping im content wird fuer Willkommen standardmaessig nicht gesetzt.
  return renderTemplate(message, { user: vars.user })
    .replace(/\{mention\}/g, vars.mention)
    .replace(/\{guild\}/g, vars.guild)
    .replace(/\{count\}/g, String(vars.memberCount))
    .replace(/\{member_count\}/g, String(vars.memberCount));
}

/**
 * Loest die in der Config gespeicherte mediaUrl in eine fuer AttachmentBuilder
 * nutzbare Quelle auf. Lokal hochgeladene Bilder werden als `/uploads/...`-Pfad
 * gespeichert (siehe POST /welcome/media) und muessen zu einem absoluten
 * Dateisystempfad relativ zu process.cwd() aufgeloest werden, damit discord.js
 * die Datei von der Platte anhaengen kann. Externe http(s)-URLs bleiben
 * unveraendert (discord.js laedt sie selbst).
 */
export function resolveWelcomeMediaSource(mediaUrl: string): string {
  if (mediaUrl.startsWith('/uploads/')) {
    return path.join(process.cwd(), mediaUrl.replace(/^\/+/, ''));
  }
  return mediaUrl;
}

type SendableChannel = { send: (options: never) => Promise<unknown> };

/**
 * Versendet die Begruessung als Embed-Nachricht.
 *
 * - Text -> Embed-Beschreibung.
 * - Bild (JPG/PNG/GIF/WEBP) -> direkt im Embed (`setImage`), lokale Uploads als
 *   `attachment://`.
 * - Video (MP4/WEBM/MOV) -> als Datei-Anhang der Nachricht (Embeds koennen kein
 *   Video darstellen); externe Video-URLs werden als Link im Embed ergaenzt.
 * - Die User-Markierung steht im Embed-Text. Ein zusaetzlicher Ping im `content`
 *   wird nur bei `mentionInContent: true` erzeugt; Standard fuer Willkommen ist
 *   ohne separaten Ping.
 */
export async function sendWelcomeMessages(
  channel: SendableChannel,
  opts: { text: string; mediaUrl?: string; mediaLayout?: 'image_first' | 'text_first'; mentionUserId?: string; mentionInContent?: boolean },
): Promise<void> {
  const ch = channel as Parameters<typeof safeSend>[0];
  const allowedMentions = opts.mentionUserId
    ? { users: [opts.mentionUserId], parse: [] as never[] }
    : { parse: [] as never[] };
  const content = opts.mentionUserId && opts.mentionInContent === true ? `<@${opts.mentionUserId}>` : undefined;

  assertWelcomeEmbedLength(opts.text);
  const embed: EmbedBuilder = vEmbed(Colors.Success).setDescription(opts.text);
  const files: AttachmentBuilder[] = [];

  if (opts.mediaUrl) {
    const url = opts.mediaUrl;
    const isLocal = url.startsWith('/uploads/');
    const isVideo = /\.(mp4|webm|mov)$/i.test(url);
    if (isVideo) {
      if (isLocal) files.push(new AttachmentBuilder(resolveWelcomeMediaSource(url)));
      else embed.addFields({ name: '🎬 Video', value: url });
    } else if (isLocal) {
      const src = resolveWelcomeMediaSource(url);
      const name = path.basename(src);
      files.push(new AttachmentBuilder(src, { name }));
      embed.setImage(`attachment://${name}`);
    } else {
      embed.setImage(url);
    }
  }

  await safeSend(ch, { content, embeds: [embed], files, allowedMentions });
}
