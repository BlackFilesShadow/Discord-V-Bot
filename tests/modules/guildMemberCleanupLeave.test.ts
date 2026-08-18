const userFindUnique = jest.fn();
const reminderDeleteMany = jest.fn();
const levelDeleteMany = jest.fn();
const xpDeleteMany = jest.fn();
const casesDeleteMany = jest.fn();
const transaction = jest.fn();

jest.mock('../../src/utils/logger', () => ({
  logger: { error: jest.fn() },
  logAudit: jest.fn(),
}));

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    user: { findUnique: userFindUnique },
    reminder: { deleteMany: reminderDeleteMany },
    levelData: { deleteMany: levelDeleteMany },
    xpRecord: { deleteMany: xpDeleteMany },
    moderationCase: { deleteMany: casesDeleteMany },
    $transaction: transaction,
  },
}));

import { cleanupGuildMemberData } from '../../src/modules/moderation/guildMemberCleanup';

const GUILD = '12345678901234567';
const DISCORD = '22345678901234567';

beforeEach(() => {
  jest.clearAllMocks();
  reminderDeleteMany.mockResolvedValue({ count: 1 });
  levelDeleteMany.mockReturnValue(Promise.resolve({ count: 2 }));
  xpDeleteMany.mockReturnValue(Promise.resolve({ count: 3 }));
  casesDeleteMany.mockReturnValue(Promise.resolve({ count: 4 }));
  transaction.mockImplementation(async (ops: Array<Promise<{ count: number }>>) => Promise.all(ops));
});

describe('Leave-1E guild member residual data cleanup', () => {
  it('deletes guild reminders even when no User row can be resolved', async () => {
    userFindUnique.mockResolvedValue(null);

    const result = await cleanupGuildMemberData(GUILD, DISCORD);

    expect(result).toEqual({
      performed: true,
      levelData: 0,
      xpRecords: 0,
      moderationCases: 0,
      reminders: 1,
    });
    expect(reminderDeleteMany).toHaveBeenCalledWith({ where: { userId: DISCORD, guildId: GUILD } });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('deletes only target-side guild data when the User row exists', async () => {
    userFindUnique.mockResolvedValue({ id: 'internal-user' });

    const result = await cleanupGuildMemberData(GUILD, DISCORD);

    expect(result).toMatchObject({
      performed: true,
      levelData: 2,
      xpRecords: 3,
      moderationCases: 4,
      reminders: 1,
    });
    expect(levelDeleteMany).toHaveBeenCalledWith({ where: { userId: 'internal-user', guildId: GUILD } });
    expect(xpDeleteMany).toHaveBeenCalledWith({ where: { userId: 'internal-user', guildId: GUILD } });
    expect(casesDeleteMany).toHaveBeenCalledWith({ where: { guildId: GUILD, targetUserId: 'internal-user' } });
    expect(reminderDeleteMany).toHaveBeenCalledWith({ where: { userId: DISCORD, guildId: GUILD } });
  });

  it('reports transaction_failed instead of claiming success when scoped deletion throws', async () => {
    userFindUnique.mockResolvedValue({ id: 'internal-user' });
    transaction.mockRejectedValue(new Error('db fail'));

    await expect(cleanupGuildMemberData(GUILD, DISCORD)).resolves.toEqual({
      performed: false,
      reason: 'transaction_failed',
      levelData: 0,
      xpRecords: 0,
      moderationCases: 0,
      reminders: 0,
    });
  });
});
