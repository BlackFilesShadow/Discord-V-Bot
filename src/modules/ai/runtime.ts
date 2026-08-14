/**
 * Symmetrische Runtime-Grenze fuer AI-nahe Background-Dienste.
 *
 * Phase 12: Der Prozess-Einstiegspunkt kennt nur noch `startAiBackgroundLoops`
 * und `stopAiBackgroundLoops`. Die einzelnen AI-Scheduler bleiben in ihren
 * Domain-Modulen; diese Runtime kapselt ausschliesslich deren Lifecycle.
 *
 * Fehler einzelner optionaler Subsysteme bleiben wie bisher best-effort und
 * werden geloggt, ohne den Discord-Command-Sync oder den Bot-Start abzubrechen.
 */

import type { Client } from 'discord.js';
import { logger } from '../../utils/logger';
import { stopContentSyncLoop } from './guildAwareness';
import { stopConversationCleanupLoop } from './conversationMemory';
import { stopTranslatedPostScheduler } from './translatedPostScheduler';

let started = false;

export async function startAiBackgroundLoops(client: Client): Promise<void> {
  if (started) return;

  try {
    const { bootstrapGuildAwareness, startContentSyncLoop } = await import('./guildAwareness.js');
    await bootstrapGuildAwareness(client);
    startContentSyncLoop(client);
    started = true;

    try {
      const { checkPgvectorAvailability, backfillEmbeddings } = await import('./embeddings.js');
      await checkPgvectorAvailability();
      void backfillEmbeddings().catch((e) => {
        logger.warn('Embedding-Backfill fehlgeschlagen:', e as Error);
      });
    } catch (e) {
      logger.warn('RAG-Initialisierung fehlgeschlagen:', e as Error);
    }

    try {
      const { startConversationCleanupLoop, cleanupOld } = await import('./conversationMemory.js');
      void cleanupOld();
      startConversationCleanupLoop();
    } catch (e) {
      logger.warn('ConversationMemory-Init fehlgeschlagen:', e as Error);
    }

    try {
      const { startTranslatedPostScheduler } = await import('./translatedPostScheduler.js');
      startTranslatedPostScheduler(client);
    } catch (e) {
      logger.warn('TranslatedPost-Scheduler-Init fehlgeschlagen:', e as Error);
    }
  } catch (e) {
    logger.warn('GuildAwareness-Bootstrap fehlgeschlagen:', e as Error);
  }
}

export function stopAiBackgroundLoops(): void {
  stopTranslatedPostScheduler();
  stopConversationCleanupLoop();
  stopContentSyncLoop();
  started = false;
}
