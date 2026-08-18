const requestFindFirst = jest.fn();
const profileFindUnique = jest.fn();
const profileUpdateMany = jest.fn();
const userFindUnique = jest.fn();
const xpDeleteMany = jest.fn();
const levelDeleteMany = jest.fn();
const levelUpsert = jest.fn();
const transaction = jest.fn();

const tx = {
  dataDeletionRequest: { findFirst: requestFindFirst },
  guildMemberProfile: {
    findUnique: profileFindUnique,
    updateMany: profileUpdateMany,
  },
  user: { findUnique: userFindUnique },
  xpRecord: { deleteMany: xpDeleteMany },
  levelData: { deleteMany: levelDeleteMany, upsert: levelUpsert },
};

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    $transaction: transaction,
  },
}));

jest.mock('../../src/modules/moderation/leaveCleanupSaga', () => ({
  leaveCleanupJobKey: (guildId: string, discordId: string) => `leave-job:v1:${guildId}:${discordId}`,
}));

import { finalizeLeaveRejoinState } from '../../src/modules/moderation/leaveCleanupRejoin';

const GUILD = '12345678901234567';
const USER = '22345678901234567';
const REQUEST = 'leave-request-1';
const CREATED = new Date('2026-08-18T06:00:00.000Z');

beforeEach(() => {
  jest.clearAllMocks();
  transaction.mockImplementation(async (fn: (client: typeof tx) => unknown) => fn(tx));
  requestFindFirst.mockResolvedValue({ createdAt: CREATED });
  userFindUnique.mockResolvedValue({ id: 'internal-user' });
  profileFindUnique.mockResolvedValue(null);
  profileUpdateMany.mockResolvedValue({ count: 1 });
  xpDeleteMany.mockResolvedValue({ count: 0 });
  levelDeleteMany.mockResolvedValue({ count: 0 });
  levelUpsert.mockResolvedValue({ id: 'level-new' });
});

describe('Leave-1G rejoin freshness finalizer', () => {
  it('requires the exact still-open raw leave request before touching player state', async () => {
    requestFindFirst.mockResolvedValue(null);

    await expect(finalizeLeaveRejoinState(REQUEST, GUILD, USER))
      .rejects.toThrow(/aktiver Request\/Scope/);

    expect(requestFindFirst).toHaveBeenCalledWith({
      where: {
        id: REQUEST,
        userId: `leave-job:v1:${GUILD}:${USER}`,
        discordId: USER,
        requestType: 'PARTIAL_DELETION',
        status: 'IN_PROGRESS',
      },
      select: { createdAt: true },
    });
    expect(profileFindUnique).not.toHaveBeenCalled();
    expect(levelUpsert).not.toHaveBeenCalled();
  });

  it('treats an old still-active profile as pre-leave state and restores the leave marker', async () => {
    profileFindUnique.mockResolvedValue({
      isLeft: false,
      leftAt: null,
      joinedAt: new Date('2026-08-01T10:00:00.000Z'),
    });

    const result = await finalizeLeaveRejoinState(REQUEST, GUILD, USER);

    expect(result).toEqual({ rejoined: false, profile: 'RESET', levelBaseline: false });
    expect(xpDeleteMany).toHaveBeenCalledWith({ where: { userId: 'internal-user', guildId: GUILD } });
    expect(levelDeleteMany).toHaveBeenCalledWith({ where: { userId: 'internal-user', guildId: GUILD } });
    expect(profileUpdateMany).toHaveBeenCalledWith({
      where: { guildId: GUILD, discordId: USER },
      data: { messageCount: 0, isLeft: true, leftAt: CREATED },
    });
    expect(levelUpsert).not.toHaveBeenCalled();
  });

  it('preserves last-known goodbye identity and an existing leftAt while clearing historical state', async () => {
    const leftAt = new Date('2026-08-18T06:00:05.000Z');
    profileFindUnique.mockResolvedValue({
      isLeft: true,
      leftAt,
      joinedAt: new Date('2026-08-01T10:00:00.000Z'),
    });
    xpDeleteMany.mockResolvedValue({ count: 2 });
    levelDeleteMany.mockResolvedValue({ count: 1 });

    const result = await finalizeLeaveRejoinState(REQUEST, GUILD, USER);

    expect(result).toEqual({ rejoined: false, profile: 'RESET', levelBaseline: false });
    expect(profileUpdateMany).toHaveBeenCalledWith({
      where: { guildId: GUILD, discordId: USER },
      data: { messageCount: 0, isLeft: true, leftAt },
    });
    expect(levelUpsert).not.toHaveBeenCalled();
  });

  it('returns NONE when no member profile exists and still removes late residual level state', async () => {
    profileFindUnique.mockResolvedValue(null);

    const result = await finalizeLeaveRejoinState(REQUEST, GUILD, USER);

    expect(result).toEqual({ rejoined: false, profile: 'NONE', levelBaseline: false });
    expect(xpDeleteMany).toHaveBeenCalledTimes(1);
    expect(levelDeleteMany).toHaveBeenCalledTimes(1);
    expect(profileUpdateMany).not.toHaveBeenCalled();
  });

  it('recognizes only joinedAt after the leave request as a genuine rejoin and restores a fresh baseline', async () => {
    const joinedAt = new Date('2026-08-18T06:05:00.000Z');
    profileFindUnique.mockResolvedValue({ isLeft: false, leftAt: null, joinedAt });

    const result = await finalizeLeaveRejoinState(REQUEST, GUILD, USER);

    expect(result).toEqual({ rejoined: true, profile: 'RESET', levelBaseline: true });
    expect(profileUpdateMany).toHaveBeenCalledWith({
      where: {
        guildId: GUILD,
        discordId: USER,
        isLeft: false,
        joinedAt: { gt: CREATED },
      },
      data: {
        messageCount: 0,
        leftAt: null,
      },
    });
    expect(levelUpsert).toHaveBeenCalledWith({
      where: { userId_guildId: { userId: 'internal-user', guildId: GUILD } },
      create: { userId: 'internal-user', guildId: GUILD },
      update: {},
    });
    expect(xpDeleteMany).not.toHaveBeenCalled();
    expect(levelDeleteMany).not.toHaveBeenCalled();
  });

  it('fails retryably if a concurrent second leave flips the active rejoin profile before reset CAS', async () => {
    profileFindUnique.mockResolvedValue({
      isLeft: false,
      leftAt: null,
      joinedAt: new Date('2026-08-18T06:05:00.000Z'),
    });
    profileUpdateMany.mockResolvedValue({ count: 0 });

    await expect(finalizeLeaveRejoinState(REQUEST, GUILD, USER))
      .rejects.toThrow(/Rejoin-Profil-CAS verloren/);

    expect(levelUpsert).not.toHaveBeenCalled();
  });

  it('fails closed instead of inventing a baseline when an active rejoin has no User row', async () => {
    profileFindUnique.mockResolvedValue({
      isLeft: false,
      leftAt: null,
      joinedAt: new Date('2026-08-18T06:05:00.000Z'),
    });
    userFindUnique.mockResolvedValue(null);

    await expect(finalizeLeaveRejoinState(REQUEST, GUILD, USER))
      .rejects.toThrow(/ohne User-Stammsatz/);

    expect(levelUpsert).not.toHaveBeenCalled();
  });
});
