import { Collection } from 'discord.js';
import type { GuildMember } from 'discord.js';

const mockProfileUpsert = jest.fn();
const mockProfileUpdateMany = jest.fn();
const mockProfileFindUnique = jest.fn();
const mockUserUpdateMany = jest.fn();

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    guildMemberProfile: {
      upsert: mockProfileUpsert,
      updateMany: mockProfileUpdateMany,
      findUnique: mockProfileFindUnique,
    },
    user: {
      updateMany: mockUserUpdateMany,
    },
  },
}));

jest.mock('../../src/utils/logger', () => ({
  logger: {
    warn: jest.fn(),
  },
}));

import {
  markMemberLeft,
  syncDiscordUserIdentity,
  syncMemberProfile,
  trackMemberActivity,
} from '../../src/modules/ai/memberAwareness';

function member(args: {
  guildId: string;
  discordId?: string;
  username?: string;
  nickname?: string | null;
  role?: string;
}): GuildMember {
  const roles = new Collection<string, { name: string; position: number }>();
  roles.set('everyone', { name: '@everyone', position: 0 });
  roles.set('role', { name: args.role ?? 'Member', position: 10 });

  return {
    id: args.discordId ?? 'discord-1',
    guild: { id: args.guildId },
    user: {
      id: args.discordId ?? 'discord-1',
      username: args.username ?? 'Void',
      discriminator: '0',
    },
    nickname: args.nickname ?? null,
    joinedAt: new Date('2026-08-01T10:00:00Z'),
    roles: { cache: roles },
    premiumSince: null,
    pending: false,
    communicationDisabledUntil: null,
  } as unknown as GuildMember;
}

describe('User-1 member awareness lifecycle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockProfileUpsert.mockResolvedValue({});
    mockProfileUpdateMany.mockResolvedValue({ count: 1 });
    mockProfileFindUnique.mockResolvedValue(null);
    mockUserUpdateMany.mockResolvedValue({ count: 1 });
  });

  it('updates a global Discord rename without touching authorization fields', async () => {
    await syncDiscordUserIdentity({
      id: 'discord-1',
      username: 'RenamedUser',
      discriminator: '0',
    });

    expect(mockUserUpdateMany).toHaveBeenCalledWith({
      where: { discordId: 'discord-1' },
      data: { username: 'RenamedUser', discriminator: '0' },
    });
    const payload = JSON.stringify(mockUserUpdateMany.mock.calls[0][0]);
    expect(payload).not.toMatch(/role|status|permission|manufacturer/i);
  });

  it('keeps nickname and role snapshots isolated for the same user in two guilds', async () => {
    const guildA = member({ guildId: 'guild-a', nickname: 'Alpha', role: 'Raid-Team' });
    const guildB = member({ guildId: 'guild-b', nickname: 'Bravo', role: 'Trader' });

    await syncMemberProfile(guildA);
    await syncMemberProfile(guildB);

    expect(mockProfileUpsert).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: { guildId_discordId: { guildId: 'guild-a', discordId: 'discord-1' } },
      update: expect.objectContaining({ nickname: 'Alpha', topRolesJson: ['Raid-Team'] }),
    }));
    expect(mockProfileUpsert).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: { guildId_discordId: { guildId: 'guild-b', discordId: 'discord-1' } },
      update: expect.objectContaining({ nickname: 'Bravo', topRolesJson: ['Trader'] }),
    }));
  });

  it('marks only the exact guild membership as left and preserves the row', async () => {
    await markMemberLeft('guild-a', 'discord-1');

    expect(mockProfileUpdateMany).toHaveBeenCalledWith({
      where: { guildId: 'guild-a', discordId: 'discord-1', isLeft: false },
      data: expect.objectContaining({ isLeft: true }),
    });
  });

  it('does not let an activity flush own isLeft/leftAt on an existing profile', async () => {
    const m = member({ guildId: 'guild-activity', discordId: 'discord-activity' });
    const now = jest.spyOn(Date, 'now').mockReturnValue(100_000);

    await trackMemberActivity(m);
    now.mockRestore();

    expect(mockProfileUpsert).toHaveBeenCalledTimes(1);
    const payload = mockProfileUpsert.mock.calls[0][0];
    // A first-time create from a real guild message may initialise active state.
    expect(payload.create).toEqual(expect.objectContaining({ isLeft: false, leftAt: null }));
    // The update path must never revive a row that markMemberLeft already closed.
    expect(payload.update).not.toHaveProperty('isLeft');
    expect(payload.update).not.toHaveProperty('leftAt');
  });

  it('does not carry unflushed pre-leave message deltas into a later rejoin phase', async () => {
    const m = member({ guildId: 'guild-delta', discordId: 'discord-delta' });
    const now = jest.spyOn(Date, 'now');

    now.mockReturnValue(100_000);
    await trackMemberActivity(m); // first delta is flushed immediately
    now.mockReturnValue(100_001);
    await trackMemberActivity(m); // one delta remains pending

    await markMemberLeft('guild-delta', 'discord-delta');

    now.mockReturnValue(200_000);
    await trackMemberActivity(m); // rejoin/runtime phase: only one new delta may flush
    now.mockRestore();

    expect(mockProfileUpsert).toHaveBeenCalledTimes(2);
    expect(mockProfileUpsert.mock.calls[1][0]).toEqual(expect.objectContaining({
      update: expect.objectContaining({ messageCount: { increment: 1 } }),
    }));
  });
});
