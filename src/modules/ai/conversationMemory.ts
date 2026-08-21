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

export async function recordTurn(
  userId: string,
  channelId: string,
  role: ConversationRole,
  content: string,
  guildId: ConversationGuildScope,
): Promise<void> {
  const trimmed = (content || '').trim().slice(0, MAX_CONTENT_PER_TURN);
  if (trimmed.length === 0) return;
  try {
    await prisma.aiConversationTurn.create({
      data: { userId, channelId, guildId, role, content: trimmed },
    });
  } catch (e) {
    logger.warn(`conversationMemory.recordTurn fehlgeschlagen: ${String(e)}`);
  }
}

/**
 * Liest History ausschliesslich aus dem explizit angegebenen Guild-/DM-Scope.
 */
export async function getRecentTurns(
  userId: string,
  channelId: string,
  guildId: ConversationGuildScope,
  limit = MAX_TURNS_PER_CONTEXT,
): Promise<ConversationTurn[]> {
  try {
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
