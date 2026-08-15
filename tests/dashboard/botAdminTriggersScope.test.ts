process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

jest.mock('../../src/dashboard/middleware/auth', () => ({
  requireBotAdmin: (req: any, _res: any, next: () => void) => {
    req.auth = { discordId: '111111111111111111', userId: 'user-db-id' };
    next();
  },
}));

jest.mock('../../src/dashboard/clientRegistry', () => ({
  tryGetDashboardClient: jest.fn(),
}));

jest.mock('../../src/modules/ai/triggers', () => ({
  addTrigger: jest.fn(),
  clearTriggers: jest.fn(),
  GLOBAL_AI_TRIGGERS: [],
  listTriggers: jest.fn(),
  MAX_TRIGGERS_PER_GUILD: 25,
  removeTrigger: jest.fn(),
}));

jest.mock('../../src/modules/ai/mediaStorage', () => ({
  deleteMediaIfLocal: jest.fn(),
  MAX_MEDIA_BYTES: 25 * 1024 * 1024,
  MEDIA_BASE_DIR: '/tmp/vbot-test-media',
  saveRemoteMedia: jest.fn(),
}));

jest.mock('../../src/modules/ai/emoteResolver', () => ({
  resolveCustomEmotes: (text: string) => text,
}));

jest.mock('../../src/utils/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
  logAudit: jest.fn(),
  logAuditDb: jest.fn(),
}));

import express from 'express';
import request from 'supertest';
import { ChannelType } from 'discord.js';
import { tryGetDashboardClient } from '../../src/dashboard/clientRegistry';
import { addTrigger, listTriggers } from '../../src/modules/ai/triggers';
import { botAdminTriggersRouter } from '../../src/dashboard/routes/v2/botAdminTriggers';

const clientMock = tryGetDashboardClient as jest.MockedFunction<typeof tryGetDashboardClient>;
const addTriggerMock = addTrigger as jest.MockedFunction<typeof addTrigger>;
const listTriggersMock = listTriggers as jest.MockedFunction<typeof listTriggers>;
const GUILD = '123456789012345678';
const CHANNEL = '223456789012345678';

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use('/triggers', botAdminTriggersRouter);
  return instance;
}

function installClient(options?: { guildPresent?: boolean; channelGuildId?: string; channelType?: ChannelType }) {
  const guild = { id: GUILD, name: 'Test Guild' };
  const guildPresent = options?.guildPresent ?? true;
  clientMock.mockReturnValue({
    guilds: {
      cache: new Map(guildPresent ? [[GUILD, guild]] : []),
      fetch: jest.fn(async (id: string) => guildPresent && id === GUILD ? guild : null),
    },
    channels: {
      fetch: jest.fn(async (id: string) => id === CHANNEL ? {
        id: CHANNEL,
        guildId: options?.channelGuildId ?? GUILD,
        type: options?.channelType ?? ChannelType.GuildText,
      } : null),
    },
  } as never);
}

function triggerPayload(overrides: Record<string, unknown> = {}) {
  return {
    guildId: GUILD,
    id: 'hello',
    triggerType: 'keyword',
    pattern: 'hello',
    responseMode: 'text',
    response: 'Hi',
    cooldownSeconds: 10,
    ...overrides,
  };
}

describe('BotAdmin trigger guild/channel scope', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    installClient();
    listTriggersMock.mockResolvedValue([]);
    addTriggerMock.mockResolvedValue({ ok: true, message: 'gespeichert' });
  });

  it('listet keine Trigger fuer erfundene oder nicht erreichbare Guilds', async () => {
    installClient({ guildPresent: false });
    const res = await request(app()).get(`/triggers?guildId=${GUILD}`);
    expect(res.status).toBe(404);
    expect(listTriggersMock).not.toHaveBeenCalled();
  });

  it('blockiert Channel-IDs aus einer anderen Guild', async () => {
    installClient({ channelGuildId: '323456789012345678' });
    const res = await request(app()).post('/triggers').send(triggerPayload({ channelId: CHANNEL }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/gehört nicht/i);
    expect(addTriggerMock).not.toHaveBeenCalled();
  });

  it('blockiert Channeltypen, die der alte Slash-Command nicht auswählen konnte', async () => {
    installClient({ channelType: ChannelType.GuildVoice });
    const res = await request(app()).post('/triggers').send(triggerPayload({ channelId: CHANNEL }));
    expect(res.status).toBe(400);
    expect(addTriggerMock).not.toHaveBeenCalled();
  });

  it('speichert einen guild-gescoppten Trigger mit erlaubtem Channel', async () => {
    const res = await request(app()).post('/triggers').send(triggerPayload({ channelId: CHANNEL }));
    expect(res.status).toBe(201);
    expect(addTriggerMock).toHaveBeenCalledTimes(1);
    expect(addTriggerMock.mock.calls[0][0]).toBe(GUILD);
    expect(addTriggerMock.mock.calls[0][1]).toMatchObject({ id: 'hello', channelId: CHANNEL, createdBy: '111111111111111111' });
  });

  it('erlaubt weiterhin serverweite Trigger ohne Channelbindung', async () => {
    const res = await request(app()).post('/triggers').send(triggerPayload());
    expect(res.status).toBe(201);
    expect(addTriggerMock).toHaveBeenCalledWith(GUILD, expect.objectContaining({ channelId: undefined }));
  });
});
