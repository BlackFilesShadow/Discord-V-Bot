/**
 * Strukturiertes Error-Tracking ("Sentry-light").
 *
 * Pusht kritische Fehler zusaetzlich zum lokalen Log an einen Discord-Webhook
 * (env: ERROR_WEBHOOK_URL). Throttling verhindert Webhook-Flood bei Fehler-Stuermen.
 *
 * Aktiv nur wenn ERROR_WEBHOOK_URL gesetzt ist — sonst No-Op.
 */

import axios from 'axios';
import { errorCounter } from './metrics';

const WEBHOOK_URL = process.env.ERROR_WEBHOOK_URL || '';
const ENABLED = WEBHOOK_URL.startsWith('https://discord.com/api/webhooks/');

// Throttling: max. 1 Push pro Fehler-Signature pro 5 min
const TTL_MS = 5 * 60 * 1000;
const recentSignatures = new Map<string, number>();
const MAX_RECENT = 1000;

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of recentSignatures) {
    if (now - v > TTL_MS) recentSignatures.delete(k);
  }
}, 60_000).unref?.();

function signatureOf(source: string, message: string): string {
  // Erste 80 Zeichen der Message + Source = stabiler Key
  return `${source}::${message.slice(0, 80)}`;
}

function shortHostname(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('os').hostname().slice(0, 32);
  } catch {
    return 'unknown';
  }
}

export interface ErrorContext {
  source: 'command' | 'dashboard' | 'event' | 'ai' | 'db' | 'other';
  userId?: string;
  command?: string;
  guildId?: string;
  extra?: Record<string, unknown>;
}

/**
 * Meldet einen Fehler an Metriken + (optional) Discord-Webhook.
 */
export function reportError(err: unknown, ctx: ErrorContext): void {
  const e = err as Error;
  const message = e?.message ?? String(err);
  errorCounter.inc({ source: ctx.source });

  if (!ENABLED) return;

  const sig = signatureOf(ctx.source, message);
  const now = Date.now();
  const last = recentSignatures.get(sig);
  if (last && now - last < TTL_MS) return; // throttled

  if (recentSignatures.size >= MAX_RECENT) {
    const firstKey = recentSignatures.keys().next().value;
    if (firstKey) recentSignatures.delete(firstKey);
  }
  recentSignatures.set(sig, now);

  const stack = (e?.stack ?? '').split('\n').slice(0, 6).join('\n');
  const fields: { name: string; value: string; inline?: boolean }[] = [
    { name: 'Source', value: ctx.source, inline: true },
    { name: 'Host', value: shortHostname(), inline: true },
  ];
  if (ctx.command) fields.push({ name: 'Command', value: ctx.command.slice(0, 100), inline: true });
  if (ctx.userId) fields.push({ name: 'User', value: ctx.userId, inline: true });
  if (ctx.guildId) fields.push({ name: 'Guild', value: ctx.guildId, inline: true });
  if (ctx.extra) {
    const extraStr = JSON.stringify(ctx.extra).slice(0, 500);
    fields.push({ name: 'Extra', value: '```json\n' + extraStr + '\n```' });
  }
  if (stack) fields.push({ name: 'Stack', value: '```\n' + stack.slice(0, 900) + '\n```' });

  // Fire-and-forget mit kurzem Timeout — Webhook-Fehler duerfen App nicht stoeren.
  axios
    .post(
      WEBHOOK_URL,
      {
        username: 'V-Bot ErrorSink',
        embeds: [
          {
            title: `\u26a0\ufe0f ${ctx.source.toUpperCase()} Error`,
            description: '```\n' + message.slice(0, 1500) + '\n```',
            color: 0xe74c3c,
            timestamp: new Date().toISOString(),
            fields,
          },
        ],
      },
      { timeout: 5000 }
    )
    .catch(() => {
      // Stille — wir wollen keine Loop, falls Webhook down.
    });
}
