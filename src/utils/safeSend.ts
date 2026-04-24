import type {
  BaseMessageOptions,
  Message,
  MessagePayload,
  TextBasedChannel,
  User,
} from 'discord.js';
import { logger } from './logger';

/**
 * Discord-Safe-Send-Helpers (Paket 2 – Security).
 *
 * Zentrale Wrapper, die fuer ALLE Bot-Outputs zwei Garantien erzwingen:
 *   1. `allowedMentions: { parse: [] }` als Default – verhindert versehentliche
 *      `@everyone`/`@here`/Rolle-Mentions, wenn Nutzereingaben Strings enthalten.
 *      Aufrufer koennen das pro Aufruf gezielt ueberschreiben (z.B. translate-post
 *      darf Rollen pingen).
 *   2. Content-Truncation auf 2000 Zeichen (Discord-Limit) – verhindert
 *      "Invalid Form Body" 50035 Crashes.
 *
 * Fehler werden gefangen + geloggt, das Promise resolved mit `null` damit
 * Aufrufer nicht zwingend try/catch brauchen.
 */

const DISCORD_MAX_CONTENT = 2000;

function ensureSafeOptions(payload: BaseMessageOptions | string): BaseMessageOptions {
  const opts: BaseMessageOptions = typeof payload === 'string' ? { content: payload } : { ...payload };
  if (typeof opts.content === 'string' && opts.content.length > DISCORD_MAX_CONTENT) {
    opts.content = opts.content.slice(0, DISCORD_MAX_CONTENT - 1) + '\u2026';
  }
  if (!opts.allowedMentions) {
    opts.allowedMentions = { parse: [] };
  }
  return opts;
}

export async function safeSend(
  target: { send: (options: string | MessagePayload | BaseMessageOptions) => Promise<Message> } | TextBasedChannel | User,
  payload: BaseMessageOptions | string,
): Promise<Message | null> {
  try {
    const opts = ensureSafeOptions(payload);
    return await (target as { send: (o: BaseMessageOptions) => Promise<Message> }).send(opts);
  } catch (e) {
    logger.warn(`safeSend fehlgeschlagen: ${String(e)}`);
    return null;
  }
}

/** Discord-User-DM versenden mit Safe-Defaults. */
export async function safeDm(user: User, payload: BaseMessageOptions | string): Promise<Message | null> {
  try {
    const dm = await user.createDM();
    return await safeSend(dm, payload);
  } catch (e) {
    logger.debug(`safeDm fehlgeschlagen (User ${user.id}): ${String(e)}`);
    return null;
  }
}

/**
 * Bereinigt einen Text BEVOR er an die LLM-Prompt-Pipeline geht.
 * - Strippt `@everyone` / `@here`
 * - Maskiert Discord-Mentions (`<@123>` -> `@User123`) damit das Modell sie nicht
 *   "echo't" und der Bot dann pingt
 * - Schneidet auf max 2000 Zeichen
 */
export function sanitizeForPrompt(input: string, maxLen = 2000): string {
  if (!input) return '';
  let out = input.replace(/@everyone/gi, '@\u200beveryone').replace(/@here/gi, '@\u200bhere');
  out = out.replace(/<@!?(\d{15,25})>/g, (_m, id: string) => `@User${id.slice(-4)}`);
  out = out.replace(/<@&(\d{15,25})>/g, (_m, id: string) => `@Role${id.slice(-4)}`);
  out = out.replace(/<#(\d{15,25})>/g, (_m, id: string) => `#chan${id.slice(-4)}`);
  if (out.length > maxLen) out = out.slice(0, maxLen);
  return out;
}

/**
 * Race-basierter Timeout-Helper. Liefert `null` wenn die Promise innerhalb von
 * `ms` nicht resolved – z.B. fuer LLM-Calls, die in der Lambda-/Provider-Latenz
 * haengen koennen.
 */
export async function withTimeout<T>(promise: Promise<T>, ms: number, label = 'op'): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race<T | null>([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          logger.warn(`withTimeout: ${label} hat ${ms}ms ueberschritten, gebe null zurueck.`);
          resolve(null);
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
