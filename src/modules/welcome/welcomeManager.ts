import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { AttachmentBuilder, type BaseMessageOptions, type Message } from 'discord.js';
import prisma from '../../database/prisma';
import { renderTemplate } from '../ai/triggers';
import { safeSend } from '../../utils/safeSend';

/**
 * Welcome-System pro Guild (BotConfig key=`welcome:<guildId>`).
 *
 * Die Begruessung wird als normale Discord-Nachricht versendet. Ein optionales
 * Bild/Medium wird als eigene Nachricht davor oder danach gesendet, damit die
 * Dashboard-Auswahl "Bild oben / Bild unten" tatsaechlich eingehalten wird.
 */

export interface WelcomeConfig {
  enabled: boolean;
  channelId: string;
  message: string;        // statischer Begruessungstext mit Platzhaltern
  mediaUrl?: string;      // optional JPG/PNG/GIF/WEBP (Bild) oder MP4/WEBM/MOV (Legacy-Link)
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
 * Zerlegt Discord-Content in atomare Einheiten. Discord-Mentions und Custom-
 * Emoji-Tags bleiben als Ganzes erhalten und koennen daher nicht zwischen zwei
 * Nachrichten zerschnitten werden.
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
 * Teilt den final gerenderten Welcome-Text sicher auf normale Discord-Nachrichten
 * mit maximal 2000 UTF-16-Code-Units. Das ist konservativer als eine reine
 * Sichtzeichen-Zaehlung und verhindert Invalid-Form-Body-Fehler bei Emoji.
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

type PreparedWelcomePart = {
  kind: 'text' | 'media';
  payload: BaseMessageOptions;
};

async function prepareWelcomeMedia(mediaUrl?: string): Promise<PreparedWelcomePart | null> {
  const url = mediaUrl?.trim();
  if (!url) return null;

  if (url.startsWith('/uploads/')) {
    const src = resolveWelcomeMediaSource(url);
    try {
      await fs.access(src);
    } catch {
      throw new Error('Das gespeicherte Willkommensbild wurde auf dem Server nicht gefunden.');
    }
    return {
      kind: 'media',
      payload: {
        files: [new AttachmentBuilder(src, { name: path.basename(src) })],
        allowedMentions: { parse: [] },
      },
    };
  }

  // Externe Medien werden bewusst NICHT serverseitig heruntergeladen (SSRF-Schutz).
  // Sie werden als eigene URL-Nachricht gesendet; Discord kann daraus eine Vorschau
  // erzeugen. Die Reihenfolge zum Text bleibt dadurch trotzdem eindeutig.
  if (url.length > MAX_WELCOME_CONTENT_LENGTH) {
    throw new Error('Die externe Medien-URL ist zu lang fuer eine Discord-Nachricht.');
  }
  return {
    kind: 'media',
    payload: { content: url, allowedMentions: { parse: [] } },
  };
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

async function rollbackWelcomeParts(messages: Message[]): Promise<void> {
  for (const message of [...messages].reverse()) {
    try { await message.delete(); } catch { /* best effort: nur eigene bereits gesendete Welcome-Teile */ }
  }
}

/**
 * Versendet die Begruessung ohne Bot-Embed als normale Discord-Nachrichten.
 *
 * - Text wird bei Bedarf sicher in <= 2000-Zeichen-Teile aufgeteilt.
 * - {user}/{mention} koennen nur den explizit uebergebenen User pingen.
 * - Lokale Bilder werden als eigener Datei-Anhang gesendet.
 * - Externe Medien bleiben als eigene URL-Nachricht (kein serverseitiger Download).
 * - mediaLayout steuert real die Reihenfolge: Bild/Medium zuerst oder Text zuerst.
 * - Schlaegt ein spaeterer Teil fehl, werden bereits gesendete Teile best-effort
 *   wieder geloescht, damit moeglichst keine halbe Welcome-Nachricht stehen bleibt.
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

  // Medien vor dem ersten Discord-Send vorbereiten/validieren, damit ein lokaler
  // Dateifehler nicht erst nach bereits gesendetem Text auffaellt.
  const mediaPart = await prepareWelcomeMedia(opts.mediaUrl);
  const textParts: PreparedWelcomePart[] = chunks.map(content => ({
    kind: 'text',
    payload: { content, allowedMentions },
  }));

  const parts: PreparedWelcomePart[] = mediaPart
    ? opts.mediaLayout === 'text_first'
      ? [...textParts, mediaPart]
      : [mediaPart, ...textParts]
    : textParts;

  const sentMessages: Message[] = [];
  try {
    for (const part of parts) {
      const label = part.kind === 'media' ? 'Willkommensbild/-medium' : 'Willkommenstext';
      sentMessages.push(await sendRequired(ch, part.payload, label));
    }
  } catch (error) {
    await rollbackWelcomeParts(sentMessages);
    throw error;
  }
}
