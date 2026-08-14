jest.mock('../../src/utils/logger', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const bootstrapGuildAwareness = jest.fn().mockResolvedValue(undefined);
const startContentSyncLoop = jest.fn();
const stopContentSyncLoop = jest.fn();
const checkPgvectorAvailability = jest.fn().mockResolvedValue(undefined);
const backfillEmbeddings = jest.fn().mockResolvedValue(undefined);
const cleanupOld = jest.fn().mockResolvedValue(undefined);
const startConversationCleanupLoop = jest.fn();
const stopConversationCleanupLoop = jest.fn();
const startTranslatedPostScheduler = jest.fn();
const stopTranslatedPostScheduler = jest.fn();

jest.mock('../../src/modules/ai/guildAwareness', () => ({
  bootstrapGuildAwareness,
  startContentSyncLoop,
  stopContentSyncLoop,
}));

jest.mock('../../src/modules/ai/embeddings', () => ({
  checkPgvectorAvailability,
  backfillEmbeddings,
}));

jest.mock('../../src/modules/ai/conversationMemory', () => ({
  cleanupOld,
  startConversationCleanupLoop,
  stopConversationCleanupLoop,
}));

jest.mock('../../src/modules/ai/translatedPostScheduler', () => ({
  startTranslatedPostScheduler,
  stopTranslatedPostScheduler,
}));

import type { Client } from 'discord.js';
import { startAiBackgroundLoops, stopAiBackgroundLoops } from '../../src/modules/ai/runtime';

describe('AI runtime lifecycle', () => {
  const client = {} as Client;

  beforeEach(() => {
    jest.clearAllMocks();
    stopAiBackgroundLoops();
    jest.clearAllMocks();
  });

  it('startet die AI-Subsysteme zentral und nur einmal', async () => {
    await startAiBackgroundLoops(client);
    await startAiBackgroundLoops(client);

    expect(bootstrapGuildAwareness).toHaveBeenCalledTimes(1);
    expect(startContentSyncLoop).toHaveBeenCalledTimes(1);
    expect(checkPgvectorAvailability).toHaveBeenCalledTimes(1);
    expect(backfillEmbeddings).toHaveBeenCalledTimes(1);
    expect(cleanupOld).toHaveBeenCalledTimes(1);
    expect(startConversationCleanupLoop).toHaveBeenCalledTimes(1);
    expect(startTranslatedPostScheduler).toHaveBeenCalledTimes(1);
  });

  it('stoppt alle gestarteten Loop-Grenzen idempotent und erlaubt danach Neustart', async () => {
    await startAiBackgroundLoops(client);
    stopAiBackgroundLoops();
    stopAiBackgroundLoops();

    expect(stopTranslatedPostScheduler).toHaveBeenCalledTimes(2);
    expect(stopConversationCleanupLoop).toHaveBeenCalledTimes(2);
    expect(stopContentSyncLoop).toHaveBeenCalledTimes(2);

    await startAiBackgroundLoops(client);
    expect(bootstrapGuildAwareness).toHaveBeenCalledTimes(2);
  });
});
