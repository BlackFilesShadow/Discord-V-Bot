/* eslint-disable local/no-unscoped-prisma-query -- Stage 64: guild boundary enforced at auth/API or entity-id unique after prior guild check; Prisma update/delete require unique where. */
import type { Client, TextChannel } from 'discord.js';
import { EmbedBuilder } from 'discord.js';
import crypto from 'crypto';
import prisma from '../../database/prisma';
import { logger, logAudit } from '../../utils/logger';

/**
 * Eingehende Webhook-Posts (Typ WEBHOOK):
 * - Endpunkt: POST /webhooks/feed/:feedId
 * - Auth: HMAC-SHA256 ueber `<unix-seconds>.<raw-body>`, geprueft gegen
 *   Feed.webhookSecret. Header:
 *     X-V-Webhook-Timestamp: <unix-seconds>
 *     X-V-Webhook-Signature: sha256=<hex>
 *   Alternativ kann X-V-Webhook-Token verwendet werden; auch dann sind
 *   frischer Timestamp + persistente Replay-Dedup Pflicht.
 * - Replay-Schutz: maximal 5 Minuten Clock-Skew; persistenter Claim im
 *   IdempotencyKey-Store verhindert dieselbe signierte Zustellung erneut.
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

export const WEBHOOK_MAX_SKEW_MS = 5 * 60 * 1000;
const WEBHOOK_REPLAY_TTL_MS = 24 * 60 * 60 * 1000;

/** Generiert ein neues Secret mit cryptografischer Zufaelligkeit. */
export function generateWebhookSecret(): string {
  return crypto.randomBytes(32).toString('hex');
}

/** Prueft HMAC-SHA256 (timing-safe). */
function verifyHmac(secret: string, signedPayload: string, signature: string): boolean {
  const expected = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
  const provided = signature.toLowerCase().replace(/^sha256=/, '');
  if (expected.length !== provided.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(provided, 'hex'));
  } catch {
    return false;
  }
}

function parseWebhookTimestamp(raw: string | string[] | undefined, nowMs = Date.now()): string | null {
  if (typeof raw !== 'string' || !/^\d{10,13}$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) return null;
  const timestampMs = raw.length === 10 ? n * 1000 : n;
  if (Math.abs(nowMs - timestampMs) > WEBHOOK_MAX_SKEW_MS) return null;
  return raw;
}

function replayHash(feedId: string, timestamp: string, rawBody: string): string {
  return `webhook:${crypto
    .createHash('sha256')
    .update(`${feedId}\n${timestamp}.${rawBody}`)
    .digest('hex')}`;
}

async function claimReplayKey(hash: string): Promise<boolean> {
  try {
    await prisma.idempotencyKey.create({
      data: {
        hash,
        status: 'PROCESSING',
        expiresAt: new Date(Date.now() + WEBHOOK_REPLAY_TTL_MS),
      },
    });
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === 'P2002') return false;
    throw error;
  }
}

async function releaseReplayKey(hash: string): Promise<void> {
  await prisma.idempotencyKey.delete({ where: { hash } }).catch(() => undefined);
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
 * Verifiziert Authentisierung, Timestamp und persistenten Replay-Claim.
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

  const timestamp = parseWebhookTimestamp(headers['x-v-webhook-timestamp']);
  if (!timestamp) return { ok: false, status: 401, reason: 'Webhook-Timestamp fehlt, ist ungueltig oder abgelaufen.' };

  const sigHeader = (headers['x-v-webhook-signature'] ?? headers['x-hub-signature-256']) as string | undefined;
  const tokenHeader = headers['x-v-webhook-token'] as string | undefined;

  let authed = false;
  if (typeof sigHeader === 'string' && sigHeader) {
    authed = verifyHmac(feed.webhookSecret, `${timestamp}.${rawBody}`, sigHeader);
  } else if (typeof tokenHeader === 'string' && tokenHeader) {
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

  const claimHash = replayHash(feed.id, timestamp, rawBody);
  if (!(await claimReplayKey(claimHash))) {
    logAudit('FEED_WEBHOOK_REPLAY_BLOCKED', 'SECURITY', { feedId: feed.id });
    return { ok: false, status: 409, reason: 'Webhook-Replay erkannt.' };
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

  try {
    await channel.send({
      ...(pingPrefix ? { content: pingPrefix } : {}),
      embeds: [embed],
      allowedMentions: { roles: roleIds, parse: [] },
    });
  } catch (error) {
    // Discord hat die Nachricht nicht angenommen. Nur in diesem Fall darf der
    // Claim freigegeben werden, damit ein echter Zustell-Retry moeglich bleibt.
    await releaseReplayKey(claimHash);
    logger.warn(`Webhook: Zustellung fuer Feed ${feed.id} fehlgeschlagen: ${String(error)}`);
    return { ok: false, status: 502, reason: 'Webhook-Zustellung fehlgeschlagen.' };
  }

  try {
    await prisma.$transaction([
      prisma.feed.update({ where: { id: feed.id }, data: { lastChecked: new Date() } }),
      prisma.idempotencyKey.update({
        where: { hash: claimHash },
        data: {
          status: 'DONE',
          responseStatus: 200,
          responseBody: { feedId: feed.id },
        },
      }),
    ]);
  } catch (error) {
    // Die Discord-Zustellung ist bereits erfolgt. Den Replay-Claim absichtlich
    // NICHT loeschen: ein Client-Retry duerfte sonst denselben Post duplizieren.
    // PROCESSING bleibt damit fail-closed und blockiert identische Replays.
    logger.error(`Webhook: Zustellung fuer Feed ${feed.id} erfolgreich, Finalisierung fehlgeschlagen: ${String(error)}`);
    logAudit('FEED_WEBHOOK_FINALIZE_FAILED', 'SECURITY', { feedId: feed.id });
    return { ok: true, status: 200 };
  }

  logAudit('FEED_WEBHOOK_DELIVERED', 'FEED', { feedId: feed.id, name: feed.name, title: data.title });
  return { ok: true, status: 200 };
}
