process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import type { UserDiscordId } from '../../src/types/scope';

const listTriggersMock = jest.fn();
const addTriggerMock = jest.fn();
const removeTriggerMock = jest.fn();
const clearTriggersMock = jest.fn();
const saveRemoteMediaMock = jest.fn();
const deleteMediaIfLocalMock = jest.fn();
const loggerErrorMock = jest.fn();
const logAuditMock = jest.fn();
const logAuditDbMock = jest.fn();

jest.mock('../../src/modules/ai/triggers', () => ({
  MAX_TRIGGERS_PER_GUILD: 25,
  listTriggers: listTriggersMock,
  addTrigger: addTriggerMock,
  removeTrigger: removeTriggerMock,
  clearTriggers: clearTriggersMock,
}));

jest.mock('../../src/modules/ai/mediaStorage', () => ({
  MAX_MEDIA_BYTES: 20 * 1024 * 1024,
  MEDIA_BASE_DIR: '/tmp/v-bot-test-media',
  saveRemoteMedia: saveRemoteMediaMock,
  deleteMediaIfLocal: deleteMediaIfLocalMock,
}));

jest.mock('../../src/modules/ai/emoteResolver', () => ({
  resolveCustomEmotes: (value: string) => value,
}));

jest.mock('../../src/utils/logger', () => ({
  logger: { error: loggerErrorMock, warn: jest.fn(), info: jest.fn() },
  logAudit: logAuditMock,
  logAuditDb: logAuditDbMock,
}));

jest.mock('../../src/dashboard/middleware/auth', () => ({
  requireBotAdmin: (
    req: Request,
    _res: Response,
    next: NextFunction,
  ) => {
    req.auth = {
      discordId: '223456789012345678' as UserDiscordId,
      userId: 'test-user-id',
      role: 'ADMIN',
    };
    next();
  },
}));

import { botAdminCommandCenterRouter } from '../../src/dashboard/routes/v2/botAdminCommandCenter';

const GUILD_ID = '123456789012345678';
const REMOTE_URL = 'https://media.example.test/no-extension';
const LOCAL_PATH = `/srv/uploads/media/triggers/${GUILD_ID}/welcome_11111111-1111-4111-8111-111111111111.png`;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/bot-admin', botAdminCommandCenterRouter);
  return app;
}

function payload(overrides: Record<string, unknown> = {}) {
  return {
    guildId: GUILD_ID,
    id: 'welcome',
    triggerType: 'keyword',
    pattern: 'hallo',
    responseMode: 'text',
    response: 'Willkommen!',
    mediaUrl: REMOTE_URL,
    cooldownSeconds: 10,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  listTriggersMock.mockResolvedValue([]);
  addTriggerMock.mockResolvedValue({ ok: true, message: 'gespeichert' });
  saveRemoteMediaMock.mockResolvedValue({ ok: true, message: 'ok', localPath: LOCAL_PATH });
  deleteMediaIfLocalMock.mockResolvedValue(undefined);
});

describe('Bot-Admin AI trigger remote media lifecycle', () => {
  it('materializes a remote URL without trusting a filename extension and persists only the local path', async () => {
    const response = await request(makeApp()).post('/bot-admin/triggers').send(payload());

    expect(response.status).toBe(201);
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

    const response = await request(makeApp()).post('/bot-admin/triggers').send(payload());

    expect(response.status).toBe(400);
    expect(addTriggerMock).not.toHaveBeenCalled();
    expect(deleteMediaIfLocalMock).not.toHaveBeenCalled();
  });

  it('rolls back newly materialized media when trigger validation fails', async () => {
    const response = await request(makeApp()).post('/bot-admin/triggers').send(payload({ pattern: '' }));

    expect(response.status).toBe(400);
    expect(addTriggerMock).not.toHaveBeenCalled();
    expect(deleteMediaIfLocalMock).toHaveBeenCalledWith(LOCAL_PATH);
  });

  it('rolls back newly materialized media when addTrigger returns a domain failure', async () => {
    addTriggerMock.mockResolvedValueOnce({ ok: false, message: 'ID existiert bereits.' });

    const response = await request(makeApp()).post('/bot-admin/triggers').send(payload());

    expect(response.status).toBe(400);
    expect(deleteMediaIfLocalMock).toHaveBeenCalledWith(LOCAL_PATH);
  });

  it('records the dashboard mutation in both audit channels after success', async () => {
    const response = await request(makeApp()).post('/bot-admin/triggers').send(payload());

    expect(response.status).toBe(201);
    expect(logAuditMock).toHaveBeenCalled();
    expect(logAuditDbMock).toHaveBeenCalled();
  });
});
