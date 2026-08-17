const mockSyncDiscordUserIdentity = jest.fn();
const mockSyncMemberProfile = jest.fn();

jest.mock('../../src/modules/ai/memberAwareness', () => ({
  syncDiscordUserIdentity: mockSyncDiscordUserIdentity,
  syncMemberProfile: mockSyncMemberProfile,
}));

jest.mock('../../src/utils/logger', () => ({
  logger: { warn: jest.fn() },
}));

import guildMemberUpdateEvent from '../../src/events/guildMemberUpdate';
import userUpdateEvent from '../../src/events/userUpdate';

function member(guildId: string, nickname: string) {
  return {
    id: 'user-1',
    guild: { id: guildId },
    user: { id: 'user-1', username: 'Renamed', discriminator: '0' },
    nickname,
  };
}

describe('User-1 Discord identity events', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSyncDiscordUserIdentity.mockResolvedValue(undefined);
    mockSyncMemberProfile.mockResolvedValue(undefined);
  });

  it('guildMemberUpdate synchronizes only the new exact guild member snapshot', async () => {
    const oldMember = member('guild-a', 'OldNick');
    const newMember = member('guild-a', 'NewNick');

    await guildMemberUpdateEvent.execute(oldMember, newMember);

    expect(mockSyncDiscordUserIdentity).toHaveBeenCalledTimes(1);
    expect(mockSyncDiscordUserIdentity).toHaveBeenCalledWith(newMember.user);
    expect(mockSyncMemberProfile).toHaveBeenCalledTimes(1);
    expect(mockSyncMemberProfile).toHaveBeenCalledWith(newMember);
    expect(mockSyncMemberProfile).not.toHaveBeenCalledWith(oldMember);
  });

  it('userUpdate rebuilds each cached current guild membership independently', async () => {
    const memberA = member('guild-a', 'Alpha');
    const memberB = member('guild-b', 'Bravo');
    const guildA = { members: { cache: new Map([['user-1', memberA]]) } };
    const guildB = { members: { cache: new Map([['user-1', memberB]]) } };
    const guildWithoutUser = { members: { cache: new Map() } };
    const user = {
      id: 'user-1',
      username: 'Renamed',
      discriminator: '0',
      client: {
        guilds: {
          cache: new Map([
            ['guild-a', guildA],
            ['guild-b', guildB],
            ['guild-c', guildWithoutUser],
          ]),
        },
      },
    };

    await userUpdateEvent.execute({ id: 'user-1', username: 'Old' }, user);

    expect(mockSyncDiscordUserIdentity).toHaveBeenCalledTimes(1);
    expect(mockSyncDiscordUserIdentity).toHaveBeenCalledWith(user);
    expect(mockSyncMemberProfile).toHaveBeenCalledTimes(2);
    expect(mockSyncMemberProfile).toHaveBeenNthCalledWith(1, memberA);
    expect(mockSyncMemberProfile).toHaveBeenNthCalledWith(2, memberB);
  });
});
