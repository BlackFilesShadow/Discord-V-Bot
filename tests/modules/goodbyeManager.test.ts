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

import {
  getGoodbyeConfig,
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

    await expect(getGoodbyeConfig('guild-a')).resolves.toEqual({ enabled: true, channelId: '12345678901234567' });
    await setGoodbyeConfig(
      'guild-b',
      { enabled: true, channelId: '12345678901234567' },
      'actor-1',
    );

    expect(mockFindUnique).toHaveBeenCalledWith({ where: { key: 'goodbye:guild-a' } });
    expect(mockUpsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { key: 'goodbye:guild-b' },
      create: expect.objectContaining({
        key: 'goodbye:guild-b', category: 'welcome', updatedBy: 'actor-1', value: { enabled: true, channelId: '12345678901234567' },
      }),
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

  it('keeps markdown-sensitive Discord names raw until the embed render step', () => {
    const identity = resolveGoodbyeIdentity(
      { discordId: '111', username: '_gateway_user_', nickname: null },
      { username: '_steffi_b_', nickname: null },
    );

    expect(identity.username).toBe('_steffi_b_');
    expect(identity.displayName).toBe('_steffi_b_');
    expect(identity.username).not.toContain('\\_');
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

  it('never promotes a raw Discord snowflake into username/displayName', () => {
    const snowflake = '1'.repeat(18);
    const identity = resolveGoodbyeIdentity(
      { discordId: snowflake, username: snowflake, nickname: null },
      { username: snowflake, nickname: snowflake },
    );

    expect(identity.username).toBe('Discord-Nutzer');
    expect(identity.nickname).toBe('Discord-Nutzer');
    expect(identity.displayName).toBe('Discord-Nutzer');
    expect(identity.mention).toBe(`<@${snowflake}>`);
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

  it('uses the fixed embed and ignores a legacy message template after a real leave', async () => {
    const discordId = '2'.repeat(18);
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
      user: { id: discordId, username: 'GatewayName' },
      nickname: 'GatewayNick',
      joinedAt,
    } as any;

    await expect(sendConfiguredGoodbye(member, { leaveOccurredAt, cleanupEnabled: false })).resolves.toBe('sent');
    expect(mockGetMemberProfile).toHaveBeenCalledWith('guild-a', discordId);
    expect(send).toHaveBeenCalledTimes(1);
    const payload = send.mock.calls[0][0];
    expect(payload.allowedMentions).toEqual({ parse: [] });
    const json = payload.embeds[0].toJSON();
    expect(json.title).toBeUndefined();
    expect(json.fields).toHaveLength(3);
    expect(json.fields?.[0]).toMatchObject({ name: '👤 Mitglied', inline: false });
    expect(json.fields?.[0].value).toContain('**Discord:** StoredNick');
    expect(json.fields?.[0].value).not.toContain('@StoredNick');
    expect(json.fields?.[0].value).not.toContain(discordId);
    expect(json.fields?.[0].value).toContain('**Status:** Server verlassen');
    expect(json.fields?.[1]).toMatchObject({ name: '📅 Mitglied seit', value: '27. April 2025', inline: true });
    expect(json.fields?.[2]).toMatchObject({ name: '🚪 Ausgetreten', inline: true });
    expect(json.fields?.[2].value).toContain('25. August 2026');
    expect(mockGoodbyeCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ joinedAt, leaveOccurredAt, discordName: 'StoredNick', customMessage: '' }),
    }));
    expect(mockGoodbyeUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ messageId: 'message-1', state: 'SENT' }),
    }));
  });

  it('still sends the independent Goodbye when cleanup identity lookup fails', async () => {
    const discordId = '3'.repeat(18);
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
      user: { id: discordId, username: 'GatewayName' },
      nickname: null,
    } as any;

    await expect(sendConfiguredGoodbye(member, {
      leaveOccurredAt: new Date('2026-08-24T10:00:00.000Z'),
      cleanupEnabled: true,
      cleanupRequestId: 'cleanup-1',
    })).resolves.toBe('sent');

    expect(send).toHaveBeenCalledTimes(1);
    const json = send.mock.calls[0][0].embeds[0].toJSON();
    const memberValue = json.fields?.find((field: { name: string }) => field.name === '👤 Mitglied')?.value;
    expect(memberValue).toContain('**Discord:** StoredUser');
    expect(memberValue).not.toContain('@StoredUser');
    expect(memberValue).not.toContain(discordId);
    expect(json.fields?.find((field: { name: string }) => field.name.includes('Whitelist'))?.value).toContain('Nicht eindeutig');
  });
});
