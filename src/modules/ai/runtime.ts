/**
 * Zentrale Shutdown-Grenze fuer AI-nahe Background-Loops, die im clientReady
 * dynamisch gestartet werden. Stop-Funktionen sind idempotent; deshalb darf
 * diese Funktion auch dann laufen, wenn ein Teil der Initialisierung zuvor
 * fehlgeschlagen ist.
 */

import { stopContentSyncLoop } from './guildAwareness';
import { stopConversationCleanupLoop } from './conversationMemory';
import { stopTranslatedPostScheduler } from './translatedPostScheduler';

export function stopAiBackgroundLoops(): void {
  stopTranslatedPostScheduler();
  stopConversationCleanupLoop();
  stopContentSyncLoop();
}
