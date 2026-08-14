jest.mock('../../src/utils/logger', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../src/modules/ai/guildAwareness', () => ({
  bootstrapGuildAwareness: jest.fn().mockResolvedValue(undefined),
  startContentSyncLoop: jest.fn(),
  stopContentSyncLoop: jest.fn(),
}));

jest.mock('../../src/modules/ai/embeddings', () => ({
  checkPgvectorAvailability: jest.fn().mockResolvedValue(undefined),
  backfillEmbeddings: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/modules/ai/conversationMemory', () => ({
  cleanupOld: jest.fn().mockResolvedValue(undefined),
  startConversationCleanupLoop: jest.fn(),
  stopConversationCleanupLoop: jest.fn(),
}));

jest.mock('../../src/modules/ai/translatedPostScheduler', () => ({
  startTranslatedPostScheduler: jest.fn(),
  stopTranslatedPostScheduler: jest.fn(),
}));

import type { Client } from 'discord.js';
import { startAiBackgroundLoops, stopAiBackgroundLoops } from '../../src/modules/ai/runtime';

const guildAwareness = jest.requireMock('../../src/modules/ai/guildAwareness') as {
  bootstrapGuildAwareness: jest.Mock;
  startContentSyncLoop: jest.Mock;
  stopContentSyncLoop: jest.Mock;
};
const embeddings = jest.requireMock('../../src/modules/ai/embeddings') as {
  checkPgvectorAvailability: jest.Mock;
  backfillEmbeddings: jest.Mock;
};
const conversationMemory = jest.requireMock('../../src/modules/ai/conversationMemory') as {
  cleanupOld: jest.Mock;
  startConversationCleanupLoop: jest.Mock;
  stopConversationCleanupLoop: jest.Mock;
};
const translatedPostScheduler = jest.requireMock('../../src/modules/ai/translatedPostScheduler') as {
  startTranslatedPostScheduler: jest.Mock;
  stopTranslatedPostScheduler: jest.Mock;
};

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

    expect(guildAwareness.bootstrapGuildAwareness).toHaveBeenCalledTimes(1);
    expect(guildAwareness.startContentSyncLoop).toHaveBeenCalledTimes(1);
    expect(embeddings.checkPgvectorAvailability).toHaveBeenCalledTimes(1);
    expect(embeddings.backfillEmbeddings).toHaveBeenCalledTimes(1);
    expect(conversationMemory.cleanupOld).toHaveBeenCalledTimes(1);
    expect(conversationMemory.startConversationCleanupLoop).toHaveBeenCalledTimes(1);
    expect(translatedPostScheduler.startTranslatedPostScheduler).toHaveBeenCalledTimes(1);
  });

  it('stoppt alle gestarteten Loop-Grenzen idempotent und erlaubt danach Neustart', async () => {
    await startAiBackgroundLoops(client);
    stopAiBackgroundLoops();
    stopAiBackgroundLoops();

    expect(translatedPostScheduler.stopTranslatedPostScheduler).toHaveBeenCalledTimes(2);
    expect(conversationMemory.stopConversationCleanupLoop).toHaveBeenCalledTimes(2);
    expect(guildAwareness.stopContentSyncLoop).toHaveBeenCalledTimes(2);

    await startAiBackgroundLoops(client);
    expect(guildAwareness.bootstrapGuildAwareness).toHaveBeenCalledTimes(2);
  });
});
