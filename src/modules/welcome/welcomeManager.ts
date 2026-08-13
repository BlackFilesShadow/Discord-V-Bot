import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import {
  AttachmentBuilder,
  MediaGalleryBuilder,
  MessageFlags,
  TextDisplayBuilder,
  type BaseMessageOptions,
  type Message,
} from 'discord.js';
import prisma from '../../database/prisma';
import { renderTemplate } from '../ai/triggers';
import { safeSend } from '../../utils/safeSend';

/**
 * Welcome-System pro Guild (BotConfig key=`welcome:<guildId>`).
 *
 * Die Begruessung wird als EINE Discord Components-V2-Nachricht versendet.
 * Bild/Medium und Text koennen dadurch in derselben Nachricht frei angeordnet
 * werden (Bild oben / Bild unten), ohne sichtbare Trennung in mehrere Bot-Posts.
 */

export interface WelcomeConfig {
  enabled: boolean;
  channelId: string;
  message: string;        // statischer Begruessungstext mit Platzhaltern
  mediaUrl?: string;      // optional JPG/PNG/GIF/WEBP/Video oder lokaler Upload
  mode?: 'text';          // nur noch statischer Text (KI-Modus entfernt)
  mediaLayout?: 'image_first' | 'text_first';
}

export const MAX_WELCOME_TEMPLATE_GRAPHEMES = 4000;
export const MAX_WELCOME_CONTENT_LENGTH = 2000;

const KEY = (guildId: string) => `welcome:${guildId}`;
const DISCORD_ATOMIC_TOKEN_RE = /<@!?\d{15,25}>|<@&\d{15,25}>|<#\d{15,25}>|<a?:[A-Za-z0-9_]{2,32}:\d{15,25}>/g;

function splitIntoGraphemes(text: string): string[] {
  const Segmenter = (Intl as unknown as {
    Segmenter?: new (locale?: string | string[], options?: { granularity: 'grapheme' }) => {
      segment(input: string): Iterable<{ segment: string }>;
    };
  }).Segmenter;

  if (Segmenter) {
    return Array.from(new Segmenter('de', { granularity: 'grapheme' }).segment(text), part => part.segment);
  }
  return Array.from(text);
}

/** Zaehlt sichtbare Unicode-Zeichen (Grapheme), sodass Emoji als ein Zeichen gelten. */
export function countWelcomeGraphemes(text: string): number {
  return splitIntoGraphemes(text).length;
}

/**
 * Zerlegt Discord-Text in atomare Einheiten. Mentions und Custom-Emoji-Tags
 * bleiben als Ganzes erhalten und werden nicht zwischen TextDisplay-Komponenten
 * zerschnitten.
 */
function tokenizeWelcomeContent(text: string): string[] {
  const tokens: string[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(DISCORD_ATOMIC_TOKEN_RE)) {
    const index = match.index ?? 0;
    if (index > lastIndex) tokens.push(...splitIntoGraphemes(text.slice(lastIndex, index)));
    tokens.push(match[0]);
    lastIndex = index + match[0].length;
  }
  if (lastIndex < text.length) tokens.push(...splitIntoGraphemes(text.slice(lastIndex)));
  return tokens;
}

/**
 * Teilt den final gerenderten Welcome-Text konservativ in <= 2000 UTF-16-
 * Code-Units. Die Teile werden spaeter NICHT als einzelne Discord-Nachrichten,
 * sondern als mehrere TextDisplay-Komponenten innerhalb EINER Nachricht gesendet.
 * Bevorzugte Trennstellen: Absatz, Zeilenumbruch, Leerzeichen; erst danach hart
 * an einer Graphem-/Discord-Token-Grenze.
 */
export function splitWelcomeContent(text: string, maxLength = MAX_WELCOME_CONTENT_LENGTH): string[] {
  if (!text) return [];
  if (!Number.isInteger(maxLength) || maxLength < 1) throw new Error('Ungueltiges Discord-Nachrichtenlimit.');
  if (text.length <= maxLength) return [text];

  const tokens = tokenizeWelcomeContent(text);
  const chunks: string[] = [];
  let start = 0;

  while (start < tokens.length) {
    let i = start;
    let used = 0;
    let lastSpace = -1;
    let lastNewline = -1;
    let lastParagraph = -1;

    while (i < tokens.length) {
      const token = tokens[i];
      if (token.length > maxLength) {
        throw new Error('Ein einzelnes Unicode-/Discord-Token ist groesser als das Nachrichtenlimit.');
      }
      if (used + token.length > maxLength) break;

      used += token.length;
      if (token === '\n') {
        lastNewline = i + 1;
        if (i > start && tokens[i - 1] === '\n') lastParagraph = i + 1;
      } else if (/^\s$/u.test(token)) {
        lastSpace = i + 1;
      }
      i += 1;
    }

    if (i === tokens.length) {
      chunks.push(tokens.slice(start).join(''));
      break;
    }

    const cut = lastParagraph > start
      ? lastParagraph
      : lastNewline > start
        ? lastNewline
        : lastSpace > start
          ? lastSpace
          : i;

    if (cut <= start) throw new Error('Willkommensnachricht konnte nicht sicher geteilt werden.');
    chunks.push(tokens.slice(start, cut).join(''));
    start = cut;
  }

  return chunks;
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
      description: `Welcome-Konfiguration fuer Guild ${guildId}`,
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
  // {user} und {mention} werden vom Join-/Test-Flow mit derselben echten
  // Discord-Erwaehnung befuellt. Es gibt keinen separaten Ping ausserhalb des Texts.
  return renderTemplate(message, { user: vars.user })
    .replace(/\{mention\}/g, vars.mention)
    .replace(/\{guild\}/g, vars.guild)
    .replace(/\{count\}/g, String(vars.memberCount))
    .replace(/\{member_count\}/g, String(vars.memberCount));
}

/** Lokale Welcome-Uploads werden zu einem absoluten Dateisystempfad aufgeloest. */
export function resolveWelcomeMediaSource(mediaUrl: string): string {
  if (mediaUrl.startsWith('/uploads/')) {
    return path.join(process.cwd(), mediaUrl.replace(/^\/+/, ''));
  }
  return mediaUrl;
}

type SendableChannel = { send: (options: never) => Promise<unknown> };

type PreparedWelcomeMedia = {
  component: MediaGalleryBuilder;
  files: AttachmentBuilder[];
};

/**
 * Bereitet das optionale Medium fuer eine Components-V2-MediaGallery vor.
 * Lokale Uploads werden als Attachment referenziert; externe URLs bleiben URLs
 * und werden weiterhin NICHT serverseitig geladen (SSRF-Schutz bleibt erhalten).
 */
async function prepareWelcomeMedia(mediaUrl?: string): Promise<PreparedWelcomeMedia | null> {
  const url = mediaUrl?.trim();
  if (!url) return null;

  if (url.startsWith('/uploads/')) {
    const src = resolveWelcomeMediaSource(url);
    try {
      await fs.access(src);
    } catch {
      throw new Error('Das gespeicherte Willkommensbild wurde auf dem Server nicht gefunden.');
    }

    const filename = path.basename(src);
    const attachment = new AttachmentBuilder(src, { name: filename });
    const component = new MediaGalleryBuilder().addItems({
      media: { url: `attachment://${filename}` },
      description: 'Willkommensbild',
    });
    return { component, files: [attachment] };
  }

  if (url.length > MAX_WELCOME_CONTENT_LENGTH) {
    throw new Error('Die externe Medien-URL ist zu lang.');
  }

  const component = new MediaGalleryBuilder().addItems({
    media: { url },
    description: 'Willkommensbild/-medium',
  });
  return { component, files: [] };
}

async function sendRequired(
  channel: Parameters<typeof safeSend>[0],
  payload: BaseMessageOptions,
  label: string,
): Promise<Message> {
  const sent = await safeSend(channel, payload);
  if (!sent) throw new Error(`${label} konnte nicht an Discord gesendet werden.`);
  return sent;
}

/**
 * Versendet die komplette Begruessung als EINE Discord Components-V2-Nachricht.
 *
 * - Bild und Text gehoeren garantiert zur selben Bot-Nachricht.
 * - mediaLayout steuert innerhalb dieser Nachricht die echte Reihenfolge.
 * - Text bleibt normaler Discord-Markdown mit Mentions und Custom-Emotes.
 * - Lange Texte werden in mehrere TextDisplay-Komponenten derselben Nachricht
 *   aufgeteilt, statt mehrere sichtbare Bot-Posts zu erzeugen.
 * - Lokale Bilder werden als Attachment in einer MediaGallery dargestellt.
 * - Externe Medien bleiben direkte URLs; kein serverseitiger Download.
 *
 * `mentionInContent` bleibt nur fuer Abwaertskompatibilitaet in der Signatur und
 * wird absichtlich ignoriert: Es gibt keinen separaten Ping ausserhalb des Texts.
 */
export async function sendWelcomeMessages(
  channel: SendableChannel,
  opts: {
    text: string;
    mediaUrl?: string;
    mediaLayout?: 'image_first' | 'text_first';
    mentionUserId?: string;
    mentionInContent?: boolean;
  },
): Promise<void> {
  const ch = channel as Parameters<typeof safeSend>[0];
  const allowedMentions = opts.mentionUserId
    ? { users: [opts.mentionUserId], parse: [] as never[] }
    : { parse: [] as never[] };

  const chunks = splitWelcomeContent(opts.text);
  if (chunks.length === 0) throw new Error('Willkommensnachricht ist leer.');

  // Vor dem einzigen Discord-Send validieren, damit bei fehlendem lokalem Bild
  // gar keine teilweise Welcome-Ausgabe entstehen kann.
  const media = await prepareWelcomeMedia(opts.mediaUrl);
  const textComponents = chunks.map(content => new TextDisplayBuilder().setContent(content));

  const components = media
    ? opts.mediaLayout === 'text_first'
      ? [...textComponents, media.component]
      : [media.component, ...textComponents]
    : textComponents;

  const payload: BaseMessageOptions = {
    flags: MessageFlags.IsComponentsV2,
    components,
    allowedMentions,
    ...(media?.files.length ? { files: media.files } : {}),
  };

  await sendRequired(ch, payload, 'Willkommensnachricht');
}
