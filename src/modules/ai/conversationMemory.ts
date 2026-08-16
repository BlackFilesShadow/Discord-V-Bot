import prisma from '../../database/prisma';
import { logger } from '../../utils/logger';

/**
 * Phase 14 / AI-3: Conversation Memory.
 *
 * Persistenz ist immer (guildId | DM-null) + userId + channelId gescoppt.
 * Discord-Channel-IDs sind zwar global eindeutige Snowflakes, die Datenebene
 * verlaesst sich fuer die Inhaltsabfrage aber bewusst NICHT allein darauf.
 * Dadurch koennen gemischte/fehlerhafte Rows niemals gemeinsam als Prompt-
 * History geladen oder gemeinsam geloescht werden.
 *
 * Bestehende Call-Sites, die historisch nur (userId, channelId, limit) kennen,
 * bleiben kompatibel: Vor dem Inhalts-Read wird einmalig nur die guildId des
 * neuesten Turns dieses Kontexts aufgeloest und anschliessend exakt auf diesen
 * Scope gefiltert. Neue Call-Sites koennen den Scope explizit uebergeben.
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

async function resolveStoredScope(
  userId: string,
  channelId: string,
  cutoff?: Date,
): Promise<ConversationGuildScope | undefined> {
  const latest = await prisma.aiConversationTurn.findFirst({
    where: {
      userId,
      channelId,
      ...(cutoff ? { createdAt: { gte: cutoff } } : {}),
    },
    orderBy: { createdAt: 'desc' },
    select: { guildId: true },
  });
  return latest?.guildId ?? (latest ? null : undefined);
}

export async function recordTurn(
  userId: string,
  channelId: string,
  role: ConversationRole,
  content: string,
  guildId?: ConversationGuildScope,
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

/**
 * Liest History nur aus EINEM Guild-/DM-Scope.
 *
 * Backward compatibility:
 *   getRecentTurns(userId, channelId, 6)
 * Neuer expliziter Scope:
 *   getRecentTurns(userId, channelId, guildId, 6)
 *   getRecentTurns(userId, channelId, null, 6) // DM
 */
export async function getRecentTurns(
  userId: string,
  channelId: string,
  guildScopeOrLimit?: ConversationGuildScope | number,
  explicitLimit = MAX_TURNS_PER_CONTEXT,
): Promise<ConversationTurn[]> {
  try {
    const cutoff = new Date(Date.now() - TTL_MS);
    const legacyLimit = typeof guildScopeOrLimit === 'number' ? guildScopeOrLimit : undefined;
    const limit = legacyLimit ?? explicitLimit;
    const explicitScope = typeof guildScopeOrLimit === 'number' ? undefined : guildScopeOrLimit;
    const guildId = explicitScope !== undefined
      ? explicitScope
      : await resolveStoredScope(userId, channelId, cutoff);

    // Kein persistierter Kontext -> keine History. Niemals auf einen
    // ungescoppten Inhalts-Read zurueckfallen.
    if (guildId === undefined) return [];

    const rows = await prisma.aiConversationTurn.findMany({
      where: { userId, channelId, guildId, createdAt: { gte: cutoff } },
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

/**
 * Loescht ebenfalls nur EINEN Guild-/DM-Scope. Wird kein Scope explizit
 * angegeben, wird der zuletzt persistierte Scope aufgeloest; ein ungescopptes
 * deleteMany ist absichtlich unmoeglich.
 */
export async function clearConversation(
  userId: string,
  channelId: string,
  guildId?: ConversationGuildScope,
): Promise<number> {
  try {
    const resolvedScope = guildId !== undefined
      ? guildId
      : await resolveStoredScope(userId, channelId);
    if (resolvedScope === undefined) return 0;

    const r = await prisma.aiConversationTurn.deleteMany({
      where: { userId, channelId, guildId: resolvedScope },
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
