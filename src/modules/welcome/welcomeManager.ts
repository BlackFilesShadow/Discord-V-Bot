import * as path from 'node:path';
import { AttachmentBuilder } from 'discord.js';
import prisma from '../../database/prisma';
import { renderTemplate } from '../ai/triggers';
import { safeSend } from '../../utils/safeSend';

/**
 * Welcome-System pro Guild (BotConfig key=`welcome:<guildId>`).
 *
 * Modi:
 *  - text:  statische Begr\u00fc\u00dfung mit {user}-Platzhalter etc.
 *  - ai:    AI generiert pers\u00f6nliche Begr\u00fc\u00dfung basierend auf aiPrompt
 */

export interface WelcomeConfig {
  enabled: boolean;
  channelId: string;
  message: string;        // Text bei mode=text ODER AI-Prompt-Vorgabe bei mode=ai
  mediaUrl?: string;      // optional JPG/PNG/GIF/MP4
  mode: 'text' | 'ai';
  mediaLayout?: 'image_first' | 'text_first'; // Reihenfolge bei gesetztem Bild (Default: image_first)
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
 * Versendet die Begruessung mit korrekter optischer Reihenfolge.
 *
 * Discord rendert `content` (Text) IMMER oberhalb eines Attachments in derselben
 * Nachricht; ein Embed-`image` liegt umgekehrt immer UNTERHALB der Description.
 * Beides liefert kein zuverlaessiges „Bild oben, Text darunter". Daher wird bei
 * `mediaLayout='image_first'` (Default) das Bild als eigene Nachricht ZUERST
 * gesendet, danach der Text — so steht das Bild optisch oben, der Text darunter.
 *
 * - kein Bild        -> eine reine Textnachricht
 * - text_first       -> eine Nachricht mit Text + Bild (Text oben, Discord-Default)
 * - image_first      -> Nachricht 1: Bild, Nachricht 2: Text
 *
 * Der User-Ping liegt ausschliesslich auf der Textnachricht (Bildnachricht ohne
 * Mentions), es gibt also weiterhin nur eine Erwaehnung.
 */
export async function sendWelcomeMessages(
  channel: SendableChannel,
  opts: { text: string; mediaUrl?: string; mediaLayout?: 'image_first' | 'text_first'; mentionUserId?: string },
): Promise<void> {
  const ch = channel as Parameters<typeof safeSend>[0];
  const content = opts.text.slice(0, 2000);
  const allowedMentions = opts.mentionUserId
    ? { users: [opts.mentionUserId], parse: [] as never[] }
    : { parse: [] as never[] };

  if (!opts.mediaUrl) {
    await safeSend(ch, { content, allowedMentions });
    return;
  }

  const attachment = new AttachmentBuilder(resolveWelcomeMediaSource(opts.mediaUrl));
  const layout = opts.mediaLayout ?? 'image_first';

  if (layout === 'image_first') {
    // Bild zuerst (ohne Ping), danach Text darunter.
    await safeSend(ch, { files: [attachment], allowedMentions: { parse: [] as never[] } });
    await safeSend(ch, { content, allowedMentions });
    return;
  }

  // text_first: Discord-Default — Text oben, Bild darunter in einer Nachricht.
  await safeSend(ch, { content, files: [attachment], allowedMentions });
}
