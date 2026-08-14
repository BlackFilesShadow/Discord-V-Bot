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
const MAX_CONTENT_PER_TURN = 4000;
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
  cleanupTimer = setInterval(() => { void cleanupOld(); }, 60 * 60 * 1000);
  cleanupTimer.unref?.();
  logger.info('conversationMemory: Cleanup-Loop gestartet (alle 60 min).');
}

export function stopConversationCleanupLoop(): void {
  if (!cleanupTimer) return;
  clearInterval(cleanupTimer);
  cleanupTimer = null;
}
