const mockFindUnique = jest.fn();
const mockUpsert = jest.fn().mockResolvedValue({});
const mockGetMemberProfile = jest.fn();
const mockGoodbyeCreate = jest.fn();
const mockGoodbyeUpdateMany = jest.fn();
const mockGoodbyeFindUnique = jest.fn();
const mockGameIdentityFindMany = jest.fn();

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    botConfig: {
      findUnique: mockFindUnique,
      upsert: mockUpsert,
    },
    goodbyeDelivery: {
      create: mockGoodbyeCreate,
      updateMany: mockGoodbyeUpdateMany,
      findUnique: mockGoodbyeFindUnique,
    },
    gameIdentityLink: { findMany: mockGameIdentityFindMany },
  },
}));

jest.mock('../../src/modules/ai/memberAwareness', () => ({
  __esModule: true,
  getMemberProfile: mockGetMemberProfile,
}));

jest.mock('../../src/modules/ai/emoteResolver', () => ({
  __esModule: true,
  resolveCustomEmotes: (value: string) => value,
}));

import {
  getGoodbyeConfig,
  renderGoodbyeMessage,
  resolveGoodbyeIdentity,
  resolveLastKnownGoodbyeIdentity,
  sendConfiguredGoodbye,
  setGoodbyeConfig,
} from '../../src/modules/welcome/goodbyeManager';

beforeEach(() => {
  jest.clearAllMocks();
  mockUpsert.mockResolvedValue({});
  mockGoodbyeCreate.mockResolvedValue({ id: 'goodbye-1', messageId: null });
  mockGoodbyeUpdateMany.mockResolvedValue({ count: 1 });
  mockGameIdentityFindMany.mockResolvedValue([]);
});

describe('Goodbye-1 guild-scoped identity and delivery', () => {
  it('stores and reads configuration under the exact guild key', async () => {
    mockFindUnique.mockResolvedValue({
      value: { enabled: true, channelId: '12345678901234567', message: 'Tschuess {user}' },
    });

    await getGoodbyeConfig('guild-a');
    await setGoodbyeConfig(
      'guild-b',
      { enabled: true, channelId: '12345678901234567', message: 'Bye' },
      'actor-1',
    );

    expect(mockFindUnique).toHaveBeenCalledWith({ where: { key: 'goodbye:guild-a' } });
    expect(mockUpsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { key: 'goodbye:guild-b' },
      create: expect.objectContaining({ key: 'goodbye:guild-b', category: 'welcome', updatedBy: 'actor-1' }),
    }));
  });

  it('prefers the persisted last guild nickname and username over gateway fallback values', () => {
    const identity = resolveGoodbyeIdentity(
      { discordId: '111', username: 'GatewayName', nickname: 'GatewayNick' },
      { username: 'StoredName', nickname: 'StoredNick' },
    );

    expect(identity).toEqual({
      discordId: '111',
      username: 'StoredName',
      nickname: 'StoredNick',
      displayName: 'StoredNick',
      mention: '<@111>',
    });
  });

  it('falls back deterministically when no persisted guild profile exists', () => {
    const identity = resolveGoodbyeIdentity(
      { discordId: '222', username: 'GatewayName', nickname: null },
      null,
    );

    expect(identity.displayName).toBe('GatewayName');
    expect(identity.nickname).toBeNull();
    expect(identity.mention).toBe('<@222>');
  });

  it('loads the last known identity from exactly guildId + discordId', async () => {
    mockGetMemberProfile.mockResolvedValue({ username: 'StoredName', nickname: 'StoredNick' });
    const member = {
      guild: { id: 'guild-a' },
      user: { id: 'discord-1', username: 'GatewayName' },
      nickname: 'GatewayNick',
    } as any;

    const identity = await resolveLastKnownGoodbyeIdentity(member);

    expect(mockGetMemberProfile).toHaveBeenCalledWith('guild-a', 'discord-1');
    expect(identity.displayName).toBe('StoredNick');
  });

  it('renders identity placeholders but removes the legacy mention placeholder from the message body', () => {
    const identity = resolveGoodbyeIdentity(
      { discordId: '333', username: 'Fallback', nickname: null },
      { username: 'StoredUser', nickname: 'StoredNick' },
    );

    const rendered = renderGoodbyeMessage(
      '{user}|{username}|{nickname}|{mention}|{guild}|{count}|{member_count}',
      { identity, guild: 'Guild A', memberCount: 42 },
    );

    expect(rendered).toBe('StoredNick|StoredUser|StoredNick||Guild A|42|42');
    expect(rendered).not.toContain('<@333>');
  });

  it('shows the readable Discord name and keeps Eintrittsdatum before Austrittsdatum', async () => {
    mockFindUnique.mockResolvedValue({
      value: { enabled: true, channelId: '12345678901234567', message: 'Bye {user} {mention}' },
    });
    mockGetMemberProfile.mockResolvedValue({ username: 'StoredUser', nickname: 'StoredNick' });
    const send = jest.fn().mockResolvedValue({ id: 'message-1' });
    const channel = { send };
    const joinedAt = new Date('2025-04-27T12:00:00.000Z');
    const leaveOccurredAt = new Date('2026-08-25T20:51:17.000Z');
    const member = {
      guild: {
        id: 'guild-a',
        name: 'Guild A',
        memberCount: 41,
        channels: { fetch: jest.fn().mockResolvedValue({ ...channel, isTextBased: () => true, isDMBased: () => false }) },
      },
      user: { id: 'discord-1', username: 'GatewayName' },
      nickname: 'GatewayNick',
      joinedAt,
    } as any;

    await expect(sendConfiguredGoodbye(member, { leaveOccurredAt, cleanupEnabled: false })).resolves.toBe('sent');
    expect(mockGetMemberProfile).toHaveBeenCalledWith('guild-a', 'discord-1');
    expect(send).toHaveBeenCalledTimes(1);
    const payload = send.mock.calls[0][0];
    expect(payload.allowedMentions).toEqual({ parse: [] });
    const json = payload.embeds[0].toJSON();
    expect(json).toMatchObject({
      title: '👋 Bye Bye',
      description: 'Bye StoredNick',
    });
    expect(json.fields?.slice(0, 5).map((field: { name: string }) => field.name)).toEqual([
      'Discord-Name',
      'Status',
      'Eintrittsdatum',
      'Austrittsdatum',
      'Uhrzeit',
    ]);
    expect(json.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Discord-Name', value: 'StoredNick' }),
      expect.objectContaining({ name: 'Status', value: 'Server verlassen' }),
      expect.objectContaining({ name: 'Eintrittsdatum', value: '27. April 2025' }),
      expect.objectContaining({ name: 'Austrittsdatum', value: '25. August 2026' }),
      expect.objectContaining({ name: 'Uhrzeit' }),
    ]));
    expect(json.description).not.toContain('<@discord-1>');
    expect(mockGoodbyeCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ joinedAt, leaveOccurredAt }),
    }));
    expect(mockGoodbyeUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ messageId: 'message-1', state: 'SENT' }),
    }));
  });

  it('still sends the independent Goodbye when cleanup identity lookup fails', async () => {
    mockFindUnique.mockResolvedValue({
      value: { enabled: true, channelId: '12345678901234567', message: 'Bye {user}' },
    });
    mockGetMemberProfile.mockResolvedValue({ username: 'StoredUser', nickname: null });
    mockGameIdentityFindMany.mockRejectedValue(new Error('identity database unavailable'));
    const send = jest.fn().mockResolvedValue({ id: 'message-2' });
    const member = {
      guild: {
        id: 'guild-a', name: 'Guild A', memberCount: 40,
        channels: { fetch: jest.fn().mockResolvedValue({ send, isTextBased: () => true, isDMBased: () => false }) },
      },
      user: { id: 'discord-1', username: 'GatewayName' },
      nickname: null,
    } as any;

    await expect(sendConfiguredGoodbye(member, {
      leaveOccurredAt: new Date('2026-08-24T10:00:00.000Z'),
      cleanupEnabled: true,
      cleanupRequestId: 'cleanup-1',
    })).resolves.toBe('sent');

    expect(send).toHaveBeenCalledTimes(1);
    const json = send.mock.calls[0][0].embeds[0].toJSON();
    expect(json.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Discord-Name', value: 'StoredUser' }),
      expect.objectContaining({ name: 'Status', value: 'Server verlassen' }),
      expect.objectContaining({ name: 'Eintrittsdatum', value: 'Unbekannt' }),
      expect.objectContaining({ name: 'Austrittsdatum' }),
      expect.objectContaining({ name: 'Whitelist-Status je Gameserver', value: expect.stringContaining('Nicht eindeutig') }),
    ]));
  });
});
