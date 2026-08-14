process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

const findManyMock = jest.fn();
const updateMock = jest.fn();
const saveFromUrlMock = jest.fn();
const resolveImageMock = jest.fn();
const removeImageMock = jest.fn();
const warnMock = jest.fn();

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    translatedPost: {
      findMany: findManyMock,
      update: updateMock,
    },
  },
}));

jest.mock('../../src/modules/ai/translatedPostImage', () => ({
  saveTranslatedPostImageFromUrl: saveFromUrlMock,
  resolveTranslatedPostImage: resolveImageMock,
  removeTranslatedPostImage: removeImageMock,
}));

jest.mock('../../src/utils/logger', () => ({
  logger: { warn: warnMock, info: jest.fn(), error: jest.fn() },
}));

import type { Client } from 'discord.js';
import {
  startTranslatedPostScheduler,
  stopTranslatedPostScheduler,
} from '../../src/modules/ai/translatedPostSchedulerV2';

const GUILD_ID = '123456789012345678';
const CHANNEL_ID = '223456789012345678';
const REMOTE_URL = 'https://images.example.test/legacy.png';
const MANAGED_REF = `upload:translated-posts/${GUILD_ID}/11111111-1111-4111-8111-111111111111.png`;

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  stopTranslatedPostScheduler();

  findManyMock.mockResolvedValue([{
    id: 'post-1',
    guildId: GUILD_ID,
    channelId: CHANNEL_ID,
    sourceText: 'Hallo',
    sourceLang: 'auto',
    targetLang: 'de',
    translatedText: 'Hallo',
    imageUrl: REMOTE_URL,
    rolePings: null,
    mode: 'now',
    recurrenceCron: null,
    customTitle: 'Titel',
  }]);
  saveFromUrlMock.mockResolvedValue(MANAGED_REF);
  resolveImageMock.mockReturnValue(null);
  removeImageMock.mockResolvedValue(undefined);
  updateMock.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
    if (data.imageUrl) throw new Error('db down');
    return {};
  });
});

afterEach(() => {
  stopTranslatedPostScheduler();
  jest.useRealTimers();
});

describe('translated post legacy remote-image migration', () => {
  it('removes the freshly materialized image if persisting its managed ref fails', async () => {
    const send = jest.fn(async () => undefined);
    const client = {
      channels: {
        fetch: jest.fn(async () => ({ send, guild: null })),
      },
    } as unknown as Client;

    startTranslatedPostScheduler(client);
    jest.advanceTimersByTime(30_000);
    for (let i = 0; i < 12; i++) await Promise.resolve();

    expect(saveFromUrlMock).toHaveBeenCalledWith(GUILD_ID, REMOTE_URL);
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: 'post-1' },
      data: { imageUrl: MANAGED_REF },
    });
    expect(removeImageMock).toHaveBeenCalledWith(MANAGED_REF);
    expect(warnMock).toHaveBeenCalledWith(expect.stringContaining('Remote-Bild'));
    expect(send).toHaveBeenCalledTimes(1);
    const payload = send.mock.calls[0][0] as { files?: unknown[] };
    expect(payload.files).toBeUndefined();
  });
});
