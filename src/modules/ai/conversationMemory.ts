/* eslint-disable local/no-unscoped-prisma-query -- Stage 64: guild boundary enforced at auth/API or entity-id unique after prior guild check; Prisma update/delete require unique where. */
import prisma from '../../database/prisma';
import { logger } from '../../utils/logger';

/**
 * AI-5: Conversation Memory mit explizitem Scope-Vertrag.
 *
 * Jede produktive Operation bekommt den Guild-/DM-Scope vom Callsite:
 * - Guild: guildId als Discord-Snowflake
 * - DM: null
 *
 * Es gibt bewusst KEINE Scope-Inferenz aus bereits gespeicherten Turns mehr.
 * Damit kann weder ein alter noch ein fehlerhaft gemischter Datensatz bestimmen,
 * welche History ein neuer Request lesen oder loeschen darf.
 *
 * - TTL: 24h. Aeltere Turns werden beim Read ausgeschlossen + periodisch geloescht.
 * - Cap: max 10 Turns (= 5 Wechsel) pro gescopptem Kontext.
 * - Inhalt wird auf 4000 Zeichen pro Turn beschnitten.
 * - Writes desselben Scopes werden serialisiert; Reads warten auf bereits
 *   gestartete Writes. Dadurch kann eine schnelle Folgefrage nicht mehr die
 *   unmittelbar vorherige Antwort verpassen.
 */

const MAX_TURNS_PER_CONTEXT = 10;
const MAX_CONTENT_PER_TURN = 4000;
const TTL_MS = 24 * 60 * 60 * 1000;

export type ConversationRole = 'user' | 'assistant';
export type ConversationGuildScope = string | null;

export interface ConversationTurn {
  role: ConversationRole;
  content: string;
}

/**
 * Nur Prozess-lokale Synchronisation fuer denselben bereits explizit gescoppten
 * Dialog. Das ist kein zusaetzlicher Datenspeicher; die kanonische Persistenz
 * bleibt PostgreSQL. Der Key enthaelt ausschliesslich den internen Scope.
 */
const pendingWrites = new Map<string, Promise<void>>();

function memoryScopeKey(
  userId: string,
  channelId: string,
  guildId: ConversationGuildScope,
): string {
  return `${guildId ?? 'dm'}\u0000${channelId}\u0000${userId}`;
}

/**
 * Wartet bis alle bereits gestarteten Writes eines Dialogs abgearbeitet sind.
 * Nach einem scheinbar leeren Queue-Zustand wird einmal in die Microtask-Queue
 * yielded. Das faengt den produktiven Aufrufer ab, der User- und Assistant-Turn
 * direkt nacheinander in einer async Sequenz schreibt.
 */
async function waitForPendingWrites(
  userId: string,
  channelId: string,
  guildId: ConversationGuildScope,
): Promise<void> {
  const key = memoryScopeKey(userId, channelId, guildId);

  for (let guard = 0; guard < 12; guard++) {
    const pending = pendingWrites.get(key);
    if (pending) {
      await pending.catch(() => undefined);
      continue;
    }

    // Der zweite Turn eines Exchanges kann unmittelbar nach Aufloesung des
    // ersten Promises eingereiht werden. Ein Microtask-Yield verhindert, dass
    // der Read genau in diese schmale Luecke faellt.
    await Promise.resolve();
    if (!pendingWrites.has(key)) return;
  }

  // Defensiver letzter Wait bei ungewoehnlich langer lokaler Write-Kette.
  await pendingWrites.get(key)?.catch(() => undefined);
}

export async function recordTurn(
  userId: string,
  channelId: string,
  role: ConversationRole,
  content: string,
  guildId: ConversationGuildScope,
): Promise<void> {
  const trimmed = (content || '').trim().slice(0, MAX_CONTENT_PER_TURN);
  if (trimmed.length === 0) return;

  const key = memoryScopeKey(userId, channelId, guildId);
  const previous = pendingWrites.get(key) ?? Promise.resolve();

  const write = previous
    .catch(() => undefined)
    .then(async () => {
      try {
        await prisma.aiConversationTurn.create({
          data: { userId, channelId, guildId, role, content: trimmed },
        });
      } catch (e) {
        logger.warn(`conversationMemory.recordTurn fehlgeschlagen: ${String(e)}`);
      }
    });

  pendingWrites.set(key, write);
  try {
    await write;
  } finally {
    if (pendingWrites.get(key) === write) pendingWrites.delete(key);
  }
}

/**
 * Liest History ausschliesslich aus dem explizit angegebenen Guild-/DM-Scope.
 * Bereits gestartete lokale Writes desselben Scopes werden zuerst abgeschlossen,
 * damit unmittelbar aufeinanderfolgende Nachrichten konsistenten Kontext sehen.
 */
export async function getRecentTurns(
  userId: string,
  channelId: string,
  guildId: ConversationGuildScope,
  limit = MAX_TURNS_PER_CONTEXT,
): Promise<ConversationTurn[]> {
  try {
    await waitForPendingWrites(userId, channelId, guildId);

    const cutoff = new Date(Date.now() - TTL_MS);
    const safeLimit = Math.max(1, Math.min(Number.isFinite(limit) ? Math.trunc(limit) : MAX_TURNS_PER_CONTEXT, MAX_TURNS_PER_CONTEXT));
    const rows = await prisma.aiConversationTurn.findMany({
      where: { userId, channelId, guildId, createdAt: { gte: cutoff } },
      orderBy: { createdAt: 'desc' },
      take: safeLimit,
    });
    return rows.reverse().map((r) => ({ role: r.role as ConversationRole, content: r.content }));
  } catch (e) {
    logger.warn(`conversationMemory.getRecentTurns fehlgeschlagen: ${String(e)}`);
    return [];
  }
}

export async function cleanupOld(): Promise<number> {
  try {
    const cutoff = new Date(Date.now() - TTL_MS);
    const r = await prisma.aiConversationTurn.deleteMany({ where: { createdAt: { lt: cutoff } } });
    if (r.count > 0) logger.info(`conversationMemory: ${r.count} alte Turns geloescht.`);
    return r.count;
  } catch (e) {
    logger.warn(`conversationMemory.cleanupOld fehlgeschlagen: ${String(e)}`);
    return 0;
  }
}

/**
 * Loescht ausschliesslich den explizit angegebenen Guild-/DM-Scope.
 */
export async function clearConversation(
  userId: string,
  channelId: string,
  guildId: ConversationGuildScope,
): Promise<number> {
  try {
    await waitForPendingWrites(userId, channelId, guildId);
    const r = await prisma.aiConversationTurn.deleteMany({
      where: { userId, channelId, guildId },
    });
    return r.count;
  } catch (e) {
    logger.warn(`conversationMemory.clearConversation fehlgeschlagen: ${String(e)}`);
    return 0;
  }
}

let cleanupTimer: NodeJS.Timeout | null = null;

export function startConversationCleanupLoop(): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => { void cleanupOld(); }, 60 * 60 * 1000);
  cleanupTimer.unref?.();
  logger.info('conversationMemory: Cleanup-Loop gestartet (alle 60 min).');
}

export function stopConversationCleanupLoop(): void {
  if (!cleanupTimer) return;
  clearInterval(cleanupTimer);
  cleanupTimer = null;
}
