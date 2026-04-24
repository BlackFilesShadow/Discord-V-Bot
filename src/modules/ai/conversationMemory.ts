import prisma from '../../database/prisma';
import { logger } from '../../utils/logger';

/**
 * Phase 14: Conversation Memory.
 *
 * Speichert pro (userId, channelId) die letzten N Turns. Beim naechsten
 * /ai-Call werden sie als Chat-Verlauf vor die aktuelle Frage gesetzt,
 * damit die AI Bezug nehmen kann ("wie eben besprochen", "und das Andere?",
 * Pronomen aufloesen etc.).
 *
 * - TTL: 24h. Aeltere Turns werden bei jedem Read gefiltert + asynchron geloescht.
 * - Cap: max 10 Turns (= 5 Wechsel) pro (userId, channelId).
 * - Inhalt wird auf 2000 Zeichen pro Turn beschnitten.
 */

const MAX_TURNS_PER_CONTEXT = 10;
const MAX_CONTENT_PER_TURN = 2000;
const TTL_MS = 24 * 60 * 60 * 1000;

export type ConversationRole = 'user' | 'assistant';

export interface ConversationTurn {
  role: ConversationRole;
  content: string;
}

export async function recordTurn(
  userId: string,
  channelId: string,
  role: ConversationRole,
  content: string,
  guildId?: string | null,
): Promise<void> {
  const trimmed = (content || '').trim().slice(0, MAX_CONTENT_PER_TURN);
  if (trimmed.length === 0) return;
  try {
    await prisma.aiConversationTurn.create({
      data: { userId, channelId, guildId: guildId ?? null, role, content: trimmed },
    });
  } catch (e) {
    logger.warn(`conversationMemory.recordTurn fehlgeschlagen: ${String(e)}`);
  }
}

export async function getRecentTurns(
  userId: string,
  channelId: string,
  limit = MAX_TURNS_PER_CONTEXT,
): Promise<ConversationTurn[]> {
  try {
    const cutoff = new Date(Date.now() - TTL_MS);
    const rows = await prisma.aiConversationTurn.findMany({
      where: { userId, channelId, createdAt: { gte: cutoff } },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    // Aelteste zuerst -> chronologisch korrekt fuer den Prompt.
    return rows.reverse().map((r) => ({ role: r.role as ConversationRole, content: r.content }));
  } catch (e) {
    logger.warn(`conversationMemory.getRecentTurns fehlgeschlagen: ${String(e)}`);
    return [];
  }
}

/**
 * Loescht alte Turns (>24h). Wird periodisch aufgerufen, um die Tabelle klein zu halten.
 */
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
 * Loescht den Verlauf einer (userId, channelId)-Kombination - z.B. fuer ein
 * "Vergiss" / Reset-Kommando.
 */
export async function clearConversation(userId: string, channelId: string): Promise<number> {
  try {
    const r = await prisma.aiConversationTurn.deleteMany({ where: { userId, channelId } });
    return r.count;
  } catch (e) {
    logger.warn(`conversationMemory.clearConversation fehlgeschlagen: ${String(e)}`);
    return 0;
  }
}

let cleanupTimer: NodeJS.Timeout | null = null;
export function startConversationCleanupLoop(): void {
  if (cleanupTimer) return;
  // Alle 60 min aufraeumen.
  cleanupTimer = setInterval(() => { void cleanupOld(); }, 60 * 60 * 1000);
  logger.info('conversationMemory: Cleanup-Loop gestartet (alle 60 min).');
}
