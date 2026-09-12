process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

const createFeedMock = jest.fn().mockResolvedValue('feed-1');
const resolveCredentialUpdateMock = jest.fn().mockReturnValue({ ok: true, change: false });
const validateBotChannelAccessMock = jest.fn().mockResolvedValue({ ok: true });

jest.mock('../../src/modules/feeds/feedManager', () => ({
  __esModule: true,
  createFeed: (...args: unknown[]) => createFeedMock(...args),
}));
jest.mock('../../src/modules/feeds/feedCredentials', () => ({
  __esModule: true,
  resolveCredentialUpdate: (...args: unknown[]) => resolveCredentialUpdateMock(...args),
}));
jest.mock('../../src/modules/feeds/webhookReceiver', () => ({
  __esModule: true,
  generateWebhookSecret: () => 'webhook-secret',
}));
jest.mock('../../src/dashboard/clientRegistry', () => ({
  __esModule: true,
  tryGetDashboardClient: () => null,
}));
jest.mock('../../src/utils/discordChannel', () => ({
  __esModule: true,
  validateBotChannelAccess: (...args: unknown[]) => validateBotChannelAccessMock(...args),
}));

import {
  createCanonicalFeed,
  isSupportedFeedType,
  normalizeFeedRoleIds,
  parseFeedInterval,
} from '../../src/dashboard/services/feedControlPlane';

const GUILD_ID = '999999999999999999';
const CHANNEL_ID = '222222222222222222';
const ROLE_ID = '333333333333333333';
const ACTOR_ID = '888888888888888888';

beforeEach(() => {
  jest.clearAllMocks();
  createFeedMock.mockResolvedValue('feed-1');
  resolveCredentialUpdateMock.mockReturnValue({ ok: true, change: false });
});

describe('feedControlPlane', () => {
  test('exposes only runtime-supported normal feed types', () => {
    for (const type of ['RSS', 'NEWS', 'TWITCH', 'STEAM', 'YOUTUBE', 'WEBHOOK']) {
      expect(isSupportedFeedType(type)).toBe(true);
    }
    expect(isSupportedFeedType('TWITTER')).toBe(false);
    expect(isSupportedFeedType('CUSTOM')).toBe(false);
  });

  test('rejects legacy TWITTER and CUSTOM before persistence', async () => {
    for (const feedType of ['TWITTER', 'CUSTOM']) {
      const result = await createCanonicalFeed({
        guildId: GUILD_ID,
        createdBy: ACTOR_ID,
        body: { name: 'Legacy', feedType, url: 'https://example.com/feed', channelId: CHANNEL_ID },
      });
      expect(result).toEqual({ ok: false, error: 'Ungültiger Feed-Typ.' });
    }
    expect(createFeedMock).not.toHaveBeenCalled();
  });

  test('canonicalizes Twitch and passes all initial state in one create call', async () => {
    resolveCredentialUpdateMock.mockReturnValue({ ok: true, change: true, value: 'enc-twitch' });
    const result = await createCanonicalFeed({
      guildId: GUILD_ID,
      createdBy: ACTOR_ID,
      body: {
        name: '',
        feedType: 'twitch',
        url: 'https://www.twitch.tv/Ninja?utm_source=test',
        channelId: CHANNEL_ID,
        interval: 30,
        mentionRoles: [ROLE_ID, ROLE_ID, 'invalid'],
        twitchClientId: 'client-id',
        twitchClientSecret: 'client-secret',
      },
    });

    expect(result).toMatchObject({
      ok: true,
      feedId: 'feed-1',
      name: 'ninja',
      feedType: 'TWITCH',
      sourceId: 'twitch:ninja',
      url: 'https://twitch.tv/ninja',
      interval: 60,
      mentionRoles: [ROLE_ID],
      credentialsSet: true,
      hasWebhookSecret: false,
    });
    expect(createFeedMock).toHaveBeenCalledTimes(1);
    expect(createFeedMock).toHaveBeenCalledWith(
      'ninja',
      'TWITCH',
      'https://twitch.tv/ninja',
      CHANNEL_ID,
      60,
      ACTOR_ID,
      GUILD_ID,
      undefined,
      { mentionRoles: [ROLE_ID], webhookSecret: null, credentialsEnc: 'enc-twitch' },
    );
  });

  test('canonicalizes YouTube handles before persistence', async () => {
    const result = await createCanonicalFeed({
      guildId: GUILD_ID,
      createdBy: ACTOR_ID,
      body: { name: 'Videos', feedType: 'YOUTUBE', url: 'https://youtube.com/@OpenAI', channelId: CHANNEL_ID },
    });

    expect(result).toMatchObject({ ok: true, feedType: 'YOUTUBE', sourceId: 'yt:@openai', url: '@OpenAI' });
    expect(createFeedMock).toHaveBeenCalledWith(
      'Videos', 'YOUTUBE', '@OpenAI', CHANNEL_ID, 300, ACTOR_ID, GUILD_ID, undefined,
      { mentionRoles: [], webhookSecret: null, credentialsEnc: null },
    );
  });

  test('generates webhook secret before the atomic create', async () => {
    const result = await createCanonicalFeed({
      guildId: GUILD_ID,
      createdBy: ACTOR_ID,
      body: { name: 'Inbound', feedType: 'WEBHOOK', url: 'Build Hook', channelId: CHANNEL_ID },
    });

    expect(result).toMatchObject({ ok: true, hasWebhookSecret: true });
    expect(createFeedMock).toHaveBeenCalledWith(
      'Inbound', 'WEBHOOK', 'Build Hook', CHANNEL_ID, 300, ACTOR_ID, GUILD_ID, undefined,
      { mentionRoles: [], webhookSecret: 'webhook-secret', credentialsEnc: null },
    );
  });

  test('keeps interval and role normalization bounded', () => {
    expect(parseFeedInterval('1')).toBe(60);
    expect(parseFeedInterval('999999')).toBe(86400);
    expect(parseFeedInterval('not-a-number')).toBe(300);
    expect(normalizeFeedRoleIds([ROLE_ID, ROLE_ID, 'x'])).toEqual([ROLE_ID]);
  });
});
