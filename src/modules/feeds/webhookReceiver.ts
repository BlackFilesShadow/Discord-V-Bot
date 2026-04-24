import type { Client, TextChannel } from 'discord.js';
import { EmbedBuilder } from 'discord.js';
import crypto from 'crypto';
import prisma from '../../database/prisma';
import { logger, logAudit } from '../../utils/logger';

/**
 * Eingehende Webhook-Posts (Typ WEBHOOK):
 * - Endpunkt: POST /webhooks/feed/:feedId
 * - Auth: HMAC-SHA256 ueber den raw body, gepruegt gegen Feed.webhookSecret
 *   (Header: X-V-Webhook-Signature: sha256=<hex>) — alternativ Token im Header
 *   X-V-Webhook-Token, falls die Quelle keine HMAC kann (z.B. simple WebHooks).
 * - Body-Format (JSON):
 *     {
 *       "title": "string",         // Pflicht
 *       "description": "string?",  // optional
 *       "url": "string?",          // optional
 *       "image": "string?",        // optional, http(s)
 *       "color": 0xRRGGBB?,        // optional
 *       "footer": "string?",       // optional, ueberschreibt Feed-Namen
 *       "timestamp": "ISO?"        // optional
 *     }
 */

export interface WebhookPayload {
  title: string;
  description?: string;
  url?: string;
  image?: string;
  color?: number;
  footer?: string;
  timestamp?: string;
}

export interface DeliveryResult {
  ok: boolean;
  status: number;
  reason?: string;
}

/** Generiert ein neues Secret mit cryptografischer Zufaelligkeit. */
export function generateWebhookSecret(): string {
  return crypto.randomBytes(32).toString('hex');
}

/** Prueft HMAC-SHA256 (timing-safe). */
function verifyHmac(secret: string, rawBody: string, signature: string): boolean {
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const provided = signature.toLowerCase().replace(/^sha256=/, '');
  if (expected.length !== provided.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
  } catch {
    return false;
  }
}

/** Validiert das JSON-Payload schwach und gibt eine kurze Fehlermeldung zurueck. */
function validatePayload(input: unknown): { ok: true; data: WebhookPayload } | { ok: false; reason: string } {
  if (!input || typeof input !== 'object') return { ok: false, reason: 'JSON-Body erwartet.' };
  const p = input as Record<string, unknown>;
  if (typeof p.title !== 'string' || !p.title.trim()) return { ok: false, reason: 'Feld "title" (string) ist Pflicht.' };
  if (p.title.length > 256) return { ok: false, reason: '"title" zu lang (max 256).' };
  for (const k of ['description', 'url', 'image', 'footer', 'timestamp'] as const) {
    if (p[k] !== undefined && typeof p[k] !== 'string') return { ok: false, reason: `"${k}" muss string sein.` };
  }
  if (p.color !== undefined && (typeof p.color !== 'number' || p.color < 0 || p.color > 0xffffff)) {
    return { ok: false, reason: '"color" muss 0..0xFFFFFF sein.' };
  }
  // SSRF-light: nur http(s) URLs
  for (const k of ['url', 'image'] as const) {
    const v = p[k];
    if (typeof v === 'string' && v && !/^https?:\/\//i.test(v)) {
      return { ok: false, reason: `"${k}" muss http(s)-URL sein.` };
    }
  }
  return {
    ok: true,
    data: {
      title: (p.title as string).slice(0, 256),
      description: typeof p.description === 'string' ? (p.description as string).slice(0, 4000) : undefined,
      url: p.url as string | undefined,
      image: p.image as string | undefined,
      color: p.color as number | undefined,
      footer: typeof p.footer === 'string' ? (p.footer as string).slice(0, 200) : undefined,
      timestamp: p.timestamp as string | undefined,
    },
  };
}

/**
 * Liefert ein Webhook-Payload an den Discord-Channel des Feeds.
 * Verifiziert HMAC bzw. den Token-Header. Loggt Audit-Eintrag.
 */
export async function deliverWebhookPayload(
  client: Client,
  feedId: string,
  rawBody: string,
  parsedJson: unknown,
  headers: Record<string, string | string[] | undefined>,
): Promise<DeliveryResult> {
  const feed = await prisma.feed.findUnique({ where: { id: feedId } });
  if (!feed) return { ok: false, status: 404, reason: 'Feed nicht gefunden.' };
  if (!feed.isActive) return { ok: false, status: 410, reason: 'Feed deaktiviert.' };
  if (feed.feedType !== 'WEBHOOK') return { ok: false, status: 400, reason: 'Feed ist kein WEBHOOK-Typ.' };
  if (!feed.webhookSecret) return { ok: false, status: 401, reason: 'Kein Secret gesetzt. Erst /feed webhook-rotate ausfuehren.' };

  const sigHeader = (headers['x-v-webhook-signature'] ?? headers['x-hub-signature-256']) as string | undefined;
  const tokenHeader = headers['x-v-webhook-token'] as string | undefined;

  let authed = false;
  if (typeof sigHeader === 'string' && sigHeader) {
    authed = verifyHmac(feed.webhookSecret, rawBody, sigHeader);
  } else if (typeof tokenHeader === 'string' && tokenHeader) {
    // Token-Vergleich timing-safe.
    const a = Buffer.from(tokenHeader);
    const b = Buffer.from(feed.webhookSecret);
    authed = a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  if (!authed) return { ok: false, status: 401, reason: 'Signatur/Token ungueltig.' };

  const v = validatePayload(parsedJson);
  if (!v.ok) return { ok: false, status: 400, reason: v.reason };
  const data = v.data;

  const channel = await client.channels.fetch(feed.channelId).catch(() => null) as TextChannel | null;
  if (!channel || !('send' in channel)) {
    logger.warn(`Webhook: Channel ${feed.channelId} fuer Feed ${feed.id} nicht erreichbar.`);
    return { ok: false, status: 502, reason: 'Discord-Channel nicht erreichbar.' };
  }

  const embed = new EmbedBuilder()
    .setTitle(data.title)
    .setColor(typeof data.color === 'number' ? data.color : 0x3498db)
    .setFooter({ text: data.footer ?? `📡 ${feed.name}` })
    .setTimestamp(data.timestamp ? new Date(data.timestamp) : new Date());
  if (data.description) embed.setDescription(data.description);
  if (data.url) embed.setURL(data.url);
  if (data.image) embed.setImage(data.image);

  const roleIds = (feed.mentionRoles ?? []).filter((id) => /^\d+$/.test(id));
  const pingPrefix = roleIds.length ? roleIds.map((id) => `<@&${id}>`).join(' ') : '';

  await channel.send({
    ...(pingPrefix ? { content: pingPrefix } : {}),
    embeds: [embed],
    allowedMentions: { roles: roleIds, parse: [] },
  });

  await prisma.feed.update({ where: { id: feed.id }, data: { lastChecked: new Date() } });
  logAudit('FEED_WEBHOOK_DELIVERED', 'FEED', { feedId: feed.id, name: feed.name, title: data.title });
  return { ok: true, status: 200 };
}
