process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

const listTriggersMock = jest.fn();
const addTriggerMock = jest.fn();
const removeTriggerMock = jest.fn();
const clearTriggersMock = jest.fn();
const saveAttachmentMock = jest.fn();
const saveRemoteMediaMock = jest.fn();
const deleteMediaIfLocalMock = jest.fn();
const loggerErrorMock = jest.fn();

jest.mock('../../src/modules/ai/triggers', () => ({
  MAX_TRIGGERS_PER_GUILD: 25,
  listTriggers: listTriggersMock,
  addTrigger: addTriggerMock,
  removeTrigger: removeTriggerMock,
  clearTriggers: clearTriggersMock,
}));

jest.mock('../../src/modules/ai/mediaStorage', () => ({
  saveAttachment: saveAttachmentMock,
  saveRemoteMedia: saveRemoteMediaMock,
  deleteMediaIfLocal: deleteMediaIfLocalMock,
}));

jest.mock('../../src/modules/ai/emoteResolver', () => ({
  resolveCustomEmotes: (value: string) => value,
}));

jest.mock('../../src/utils/logger', () => ({
  logger: { error: loggerErrorMock, warn: jest.fn(), info: jest.fn() },
}));

jest.mock('../../src/utils/embedDesign', () => {
  function embed() {
    const value: Record<string, jest.Mock> = {};
    value.setDescription = jest.fn(() => value);
    value.setTitle = jest.fn(() => value);
    value.addFields = jest.fn(() => value);
    return value;
  }
  return {
    Colors: { Error: 1, Success: 2, Info: 3 },
    vEmbed: jest.fn(() => embed()),
  };
});

import { aiTriggerCommand } from '../../src/commands/admin/aiTrigger';

const GUILD_ID = '123456789012345678';
const USER_ID = '223456789012345678';
const REMOTE_URL = 'https://media.example.test/no-extension';
const LOCAL_PATH = `/srv/uploads/media/triggers/${GUILD_ID}/welcome_11111111-1111-4111-8111-111111111111.png`;

function interaction(overrides: { mediaUrl?: string | null; attachment?: unknown } = {}) {
  const values: Record<string, string | null> = {
    id: 'welcome',
    typ: 'keyword',
    pattern: 'hallo',
    modus: 'text',
    antwort: 'Willkommen!',
    'media-url': overrides.mediaUrl === undefined ? REMOTE_URL : overrides.mediaUrl,
  };
  return {
    guildId: GUILD_ID,
    guild: {},
    user: { id: USER_ID },
    options: {
      getSubcommand: jest.fn(() => 'add'),
      getString: jest.fn((name: string) => values[name] ?? null),
      getChannel: jest.fn(() => null),
      getAttachment: jest.fn(() => overrides.attachment ?? null),
      getInteger: jest.fn(() => null),
    },
    deferReply: jest.fn(async () => undefined),
    editReply: jest.fn(async () => undefined),
    reply: jest.fn(async () => undefined),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  listTriggersMock.mockResolvedValue([]);
  addTriggerMock.mockResolvedValue({ ok: true, message: 'gespeichert' });
  saveRemoteMediaMock.mockResolvedValue({ ok: true, message: 'ok', localPath: LOCAL_PATH });
  saveAttachmentMock.mockResolvedValue({ ok: true, message: 'ok', localPath: LOCAL_PATH });
  deleteMediaIfLocalMock.mockResolvedValue(undefined);
});

describe('/ai-trigger add remote media lifecycle', () => {
  it('materializes a remote URL without trusting a filename extension and persists only the local path', async () => {
    const i = interaction();

    await aiTriggerCommand.execute(i as never);

    expect(saveRemoteMediaMock).toHaveBeenCalledWith(REMOTE_URL, 'triggers', GUILD_ID, 'welcome');
    expect(addTriggerMock).toHaveBeenCalledWith(
      GUILD_ID,
      expect.objectContaining({
        id: 'welcome',
        mediaUrl: LOCAL_PATH,
      }),
    );
    const trigger = addTriggerMock.mock.calls[0][1] as { mediaUrl?: string };
    expect(trigger.mediaUrl).not.toBe(REMOTE_URL);
    expect(deleteMediaIfLocalMock).not.toHaveBeenCalled();
  });

  it('fails closed when remote ingestion rejects the input and never writes the trigger', async () => {
    saveRemoteMediaMock.mockResolvedValueOnce({ ok: false, message: '❌ SSRF blockiert.' });
    const i = interaction();

    await aiTriggerCommand.execute(i as never);

    expect(addTriggerMock).not.toHaveBeenCalled();
    expect(deleteMediaIfLocalMock).not.toHaveBeenCalled();
    expect(i.editReply).toHaveBeenCalledTimes(1);
  });

  it('rolls back the newly materialized file when addTrigger returns a domain failure', async () => {
    addTriggerMock.mockResolvedValueOnce({ ok: false, message: 'ID existiert bereits.' });
    const i = interaction();

    await aiTriggerCommand.execute(i as never);

    expect(deleteMediaIfLocalMock).toHaveBeenCalledWith(LOCAL_PATH);
  });

  it('rolls back the newly materialized file when persistence throws', async () => {
    addTriggerMock.mockRejectedValueOnce(new Error('db down'));
    const i = interaction();

    await aiTriggerCommand.execute(i as never);

    expect(deleteMediaIfLocalMock).toHaveBeenCalledWith(LOCAL_PATH);
    expect(loggerErrorMock).toHaveBeenCalled();
    expect(i.editReply).toHaveBeenCalledTimes(1);
  });

  it('rejects attachment plus remote URL before any media is downloaded', async () => {
    const i = interaction({ attachment: { name: 'image.png' } });

    await aiTriggerCommand.execute(i as never);

    expect(saveRemoteMediaMock).not.toHaveBeenCalled();
    expect(saveAttachmentMock).not.toHaveBeenCalled();
    expect(addTriggerMock).not.toHaveBeenCalled();
  });
});
