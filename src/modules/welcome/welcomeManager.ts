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
 * optionales Bild im Embed). Der User-Ping liegt im `content`, damit der neue
 * Member zuverlaessig erwaehnt wird. Es gibt ausschliesslich statische,
 * selbst erstellte Texte mit Platzhaltern ({user}, {guild}, {count}) —
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

const KEY = (guildId: string) => `welcome:${guildId}`;

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

export function renderWelcomeMessage(message: string, vars: { user: string; guild: string; memberCount: number }): string {
  return renderTemplate(message, { user: vars.user })
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
 * - Der User-Ping liegt im `content` (Embeds loesen keine Erwaehnung aus).
 */
export async function sendWelcomeMessages(
  channel: SendableChannel,
  opts: { text: string; mediaUrl?: string; mediaLayout?: 'image_first' | 'text_first'; mentionUserId?: string },
): Promise<void> {
  const ch = channel as Parameters<typeof safeSend>[0];
  const allowedMentions = opts.mentionUserId
    ? { users: [opts.mentionUserId], parse: [] as never[] }
    : { parse: [] as never[] };
  const content = opts.mentionUserId ? `<@${opts.mentionUserId}>` : undefined;

  const embed: EmbedBuilder = vEmbed(Colors.Success).setDescription(opts.text.slice(0, 4096));
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
