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
import { scheduleProviderCooldownSync, stopProviderCooldownSync } from './providerStats';
import { getProductionAiToolExecutor, listProductionAiToolNames } from './toolRuntime';

let started = false;

export async function startAiBackgroundLoops(client: Client): Promise<void> {
  if (started) return;

  try {
    // Provider-Cooldowns sind persistenter Runtime-Zustand. Sie muessen direkt
    // beim AI-Lifecycle aus der DB hydriert und anschliessend synchron gehalten
    // werden, damit Restart/Multi-Instance nicht erneut in bekannte 429-/Model-
    // Fehler laeuft.
    scheduleProviderCooldownSync();

    // AI-18: fail-closed production tool registry must be live before chat loops.
    // No destructive tools are registered; LLM proposals only execute via toolRuntime.
    const toolExecutor = getProductionAiToolExecutor();
    logger.info(`[AI-18] Tool layer wired (${listProductionAiToolNames().join(', ') || 'none'}); describe=${toolExecutor.describe().length}`);

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
  stopProviderCooldownSync();
  stopTranslatedPostScheduler();
  stopConversationCleanupLoop();
  stopContentSyncLoop();
  started = false;
}
