const userFindUnique = jest.fn();
const reminderDeleteMany = jest.fn();
const levelDeleteMany = jest.fn();
const xpDeleteMany = jest.fn();
const casesDeleteMany = jest.fn();
const permissionDeleteMany = jest.fn();
const factionFindMany = jest.fn();
const factionMemberDeleteMany = jest.fn();
const factionUpdateMany = jest.fn();
const transaction = jest.fn();
const tryGetDashboardClient = jest.fn();
const postFactionEmbed = jest.fn();
const postFactionList = jest.fn();
const logAudit = jest.fn();
const loggerWarn = jest.fn();
const loggerError = jest.fn();

jest.mock('../../src/utils/logger', () => ({
  logger: { error: loggerError, warn: loggerWarn },
  logAudit: (...args: unknown[]) => logAudit(...args),
}));

jest.mock('../../src/dashboard/clientRegistry', () => ({
  tryGetDashboardClient: (...args: unknown[]) => tryGetDashboardClient(...args),
}));

jest.mock('../../src/modules/factions/factionEmbed', () => ({
  postFactionEmbed: (...args: unknown[]) => postFactionEmbed(...args),
  postFactionList: (...args: unknown[]) => postFactionList(...args),
}));

const tx = {
  user: { findUnique: userFindUnique },
  reminder: { deleteMany: reminderDeleteMany },
  levelData: { deleteMany: levelDeleteMany },
  xpRecord: { deleteMany: xpDeleteMany },
  moderationCase: { deleteMany: casesDeleteMany },
  guildPermissionGrant: { deleteMany: permissionDeleteMany },
  faction: { findMany: factionFindMany, updateMany: factionUpdateMany },
  factionMember: { deleteMany: factionMemberDeleteMany },
};

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    $transaction: (...args: unknown[]) => transaction(...args),
  },
}));

import { cleanupGuildMemberData } from '../../src/modules/moderation/guildMemberCleanup';

const GUILD = '12345678901234567';
const DISCORD = '22345678901234567';

beforeEach(() => {
  jest.clearAllMocks();
  transaction.mockImplementation(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx));
  userFindUnique.mockResolvedValue({ id: 'internal-user' });
  reminderDeleteMany.mockResolvedValue({ count: 1 });
  permissionDeleteMany.mockResolvedValue({ count: 1 });
  factionFindMany.mockResolvedValue([{ id: 'faction-a' }, { id: 'faction-b' }]);
  factionMemberDeleteMany.mockResolvedValue({ count: 2 });
  factionUpdateMany
    .mockResolvedValueOnce({ count: 1 })
    .mockResolvedValueOnce({ count: 0 })
    .mockResolvedValueOnce({ count: 1 });
  levelDeleteMany.mockResolvedValue({ count: 2 });
  xpDeleteMany.mockResolvedValue({ count: 3 });
  casesDeleteMany.mockResolvedValue({ count: 4 });
  tryGetDashboardClient.mockReturnValue(null);
  postFactionEmbed.mockResolvedValue({ messageId: 'm1', updated: true });
  postFactionList.mockResolvedValue(undefined);
});

describe('Leave-1H guild member residual live-state cleanup', () => {
  it('removes direct guild live-state even when no User row can be resolved', async () => {
    userFindUnique.mockResolvedValue(null);

    const result = await cleanupGuildMemberData(GUILD, DISCORD);

    expect(result).toEqual({
      performed: true,
      levelData: 0,
      xpRecords: 0,
      moderationCases: 0,
      reminders: 1,
      permissionGrants: 1,
      factionMemberships: 2,
      factionLeadershipRefs: 2,
    });
    expect(permissionDeleteMany).toHaveBeenCalledWith({ where: { guildId: GUILD, userDiscordId: DISCORD } });
    expect(reminderDeleteMany).toHaveBeenCalledWith({ where: { userId: DISCORD, guildId: GUILD } });
    expect(levelDeleteMany).not.toHaveBeenCalled();
    expect(xpDeleteMany).not.toHaveBeenCalled();
    expect(casesDeleteMany).not.toHaveBeenCalled();
  });

  it('discovers only same-guild faction state for the leaving user', async () => {
    await cleanupGuildMemberData(GUILD, DISCORD);

    expect(factionFindMany).toHaveBeenCalledWith({
      where: {
        guildId: GUILD,
        OR: [
          { leaderDiscordId: DISCORD },
          { deputyDiscordId: DISCORD },
          { treasurerDiscordId: DISCORD },
          { members: { some: { userDiscordId: DISCORD } } },
        ],
      },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    expect(factionMemberDeleteMany).toHaveBeenCalledWith({
      where: {
        factionId: { in: ['faction-a', 'faction-b'] },
        userDiscordId: DISCORD,
      },
    });
  });

  it('clears each leadership reference only inside the target guild', async () => {
    await cleanupGuildMemberData(GUILD, DISCORD);

    expect(factionUpdateMany).toHaveBeenNthCalledWith(1, {
      where: { guildId: GUILD, leaderDiscordId: DISCORD },
      data: { leaderDiscordId: null },
    });
    expect(factionUpdateMany).toHaveBeenNthCalledWith(2, {
      where: { guildId: GUILD, deputyDiscordId: DISCORD },
      data: { deputyDiscordId: null },
    });
    expect(factionUpdateMany).toHaveBeenNthCalledWith(3, {
      where: { guildId: GUILD, treasurerDiscordId: DISCORD },
      data: { treasurerDiscordId: null },
    });
  });

  it('deletes target-side user-linked guild data while preserving actor/audit state', async () => {
    const result = await cleanupGuildMemberData(GUILD, DISCORD);

    expect(result).toMatchObject({
      performed: true,
      levelData: 2,
      xpRecords: 3,
      moderationCases: 4,
      reminders: 1,
      permissionGrants: 1,
      factionMemberships: 2,
      factionLeadershipRefs: 2,
    });
    expect(levelDeleteMany).toHaveBeenCalledWith({ where: { userId: 'internal-user', guildId: GUILD } });
    expect(xpDeleteMany).toHaveBeenCalledWith({ where: { userId: 'internal-user', guildId: GUILD } });
    expect(casesDeleteMany).toHaveBeenCalledWith({ where: { guildId: GUILD, targetUserId: 'internal-user' } });
  });

  it('refreshes only affected faction presentation after the DB transaction', async () => {
    const client = { user: { id: 'bot' } };
    tryGetDashboardClient.mockReturnValue(client);

    await cleanupGuildMemberData(GUILD, DISCORD);

    expect(postFactionEmbed).toHaveBeenCalledTimes(2);
    expect(postFactionEmbed).toHaveBeenNthCalledWith(1, client, 'faction-a');
    expect(postFactionEmbed).toHaveBeenNthCalledWith(2, client, 'faction-b');
    expect(postFactionList).toHaveBeenCalledWith(client, GUILD);
    expect(transaction.mock.invocationCallOrder[0]).toBeLessThan(postFactionEmbed.mock.invocationCallOrder[0]);
  });

  it('keeps completed DB cleanup successful when Discord faction refresh fails', async () => {
    tryGetDashboardClient.mockReturnValue({ user: { id: 'bot' } });
    postFactionEmbed.mockRejectedValue(new Error('discord unavailable'));
    postFactionList.mockRejectedValue(new Error('discord unavailable'));

    await expect(cleanupGuildMemberData(GUILD, DISCORD)).resolves.toMatchObject({ performed: true });
    expect(loggerWarn).toHaveBeenCalled();
    expect(loggerError).not.toHaveBeenCalled();
  });

  it('does not touch faction presentation when the user has no faction live-state', async () => {
    factionFindMany.mockResolvedValue([]);
    factionMemberDeleteMany.mockResolvedValue({ count: 0 });
    factionUpdateMany.mockReset();
    factionUpdateMany.mockResolvedValue({ count: 0 });
    tryGetDashboardClient.mockReturnValue({ user: { id: 'bot' } });

    await cleanupGuildMemberData(GUILD, DISCORD);

    expect(factionMemberDeleteMany).not.toHaveBeenCalled();
    expect(postFactionEmbed).not.toHaveBeenCalled();
    expect(postFactionList).not.toHaveBeenCalled();
  });

  it('reports transaction_failed instead of claiming success when scoped deletion throws', async () => {
    transaction.mockRejectedValue(new Error('db fail'));

    await expect(cleanupGuildMemberData(GUILD, DISCORD)).resolves.toEqual({
      performed: false,
      reason: 'transaction_failed',
      levelData: 0,
      xpRecords: 0,
      moderationCases: 0,
      reminders: 0,
      permissionGrants: 0,
      factionMemberships: 0,
      factionLeadershipRefs: 0,
    });
    expect(postFactionEmbed).not.toHaveBeenCalled();
    expect(postFactionList).not.toHaveBeenCalled();
  });

  it('audits the security- and faction-state removals without storing new raw state', async () => {
    await cleanupGuildMemberData(GUILD, DISCORD);

    expect(logAudit).toHaveBeenCalledWith('GUILD_MEMBER_DATA_CLEANUP', 'MODERATION', expect.objectContaining({
      guildId: GUILD,
      discordId: DISCORD,
      permissionGrants: 1,
      factionMemberships: 2,
      factionLeadershipRefs: 2,
    }));
  });
});
