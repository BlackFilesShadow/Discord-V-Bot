const claimQuery = jest.fn();
const profileFindUnique = jest.fn();
const profileUpdateMany = jest.fn();
const userFindUnique = jest.fn();
const xpDeleteMany = jest.fn();
const levelDeleteMany = jest.fn();
const levelUpsert = jest.fn();
const transaction = jest.fn();

const tx = {
  $queryRawUnsafe: claimQuery,
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
  readLeaveCleanupDetails: (value: unknown) => value,
}));

import { finalizeLeaveRejoinState } from '../../src/modules/moderation/leaveCleanupRejoin';

const GUILD = '12345678901234567';
const USER = '22345678901234567';
const REQUEST = 'leave-request-1';
const CREATED = new Date('2026-08-18T06:00:00.000Z');
const JOB_KEY = `leave-job:v1:${GUILD}:${USER}`;

function claimedRequest(details: Record<string, unknown> = {}) {
  return {
    id: REQUEST,
    userId: JOB_KEY,
    discordId: USER,
    status: 'IN_PROGRESS' as const,
    scheduledAt: CREATED,
    details: {
      kind: 'GUILD_LEAVE_CLEANUP_V1',
      guildId: GUILD,
      step: 'GUILD_DATA',
      stage: 'RUNNING',
      attempts: 0,
      maxAttempts: 8,
      claimToken: 'claim-a',
      ...details,
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  transaction.mockImplementation(async (fn: (client: typeof tx) => unknown) => fn(tx));
  claimQuery.mockResolvedValue([{ createdAt: CREATED }]);
  userFindUnique.mockResolvedValue({ id: 'internal-user' });
  profileFindUnique.mockResolvedValue(null);
  profileUpdateMany.mockResolvedValue({ count: 1 });
  xpDeleteMany.mockResolvedValue({ count: 0 });
  levelDeleteMany.mockResolvedValue({ count: 0 });
  levelUpsert.mockResolvedValue({ id: 'level-new' });
});

describe('Leave-1G rejoin freshness finalizer', () => {
  it('locks and fences the exact active claim before touching player state', async () => {
    claimQuery.mockResolvedValue([]);
    const current = claimedRequest();

    await expect(finalizeLeaveRejoinState(current, GUILD, USER))
      .rejects.toThrow(/aktiver Claim\/Scope/);

    expect(claimQuery).toHaveBeenCalledTimes(1);
    const call = claimQuery.mock.calls[0];
    expect(String(call[0])).toContain('FOR UPDATE');
    expect(String(call[0])).toContain('jsonb_extract_path_text("details", $4)=$5');
    expect(call.slice(1)).toEqual([REQUEST, JOB_KEY, USER, 'claimToken', 'claim-a']);
    expect(profileFindUnique).not.toHaveBeenCalled();
    expect(userFindUnique).not.toHaveBeenCalled();
    expect(levelUpsert).not.toHaveBeenCalled();
  });

  it('rejects a corrupted in-memory request scope before opening the transaction', async () => {
    const corrupted = { ...claimedRequest(), userId: `leave-job:v1:${GUILD}:99999999999999999` };

    await expect(finalizeLeaveRejoinState(corrupted, GUILD, USER))
      .rejects.toThrow(/geclaimter Request\/Scope/);

    expect(transaction).not.toHaveBeenCalled();
    expect(claimQuery).not.toHaveBeenCalled();
  });

  it('supports pre-1F legacy claims through the persisted claimedAt fence', async () => {
    const current = claimedRequest({ claimToken: undefined, claimedAt: '2026-08-18T06:01:00.000Z' });

    await expect(finalizeLeaveRejoinState(current, GUILD, USER)).resolves.toEqual({
      rejoined: false,
      profile: 'NONE',
      levelBaseline: false,
    });

    const call = claimQuery.mock.calls[0];
    expect(call[4]).toBe('claimedAt');
    expect(call[5]).toBe('2026-08-18T06:01:00.000Z');
  });

  it('fails before any mutation when neither claimToken nor claimedAt is available', async () => {
    const current = claimedRequest({ claimToken: undefined });

    await expect(finalizeLeaveRejoinState(current, GUILD, USER))
      .rejects.toThrow(/Claim-Fence fehlt/);

    expect(transaction).not.toHaveBeenCalled();
    expect(profileFindUnique).not.toHaveBeenCalled();
  });

  it('treats an old still-active profile as pre-leave state and restores the leave marker through exact snapshot CAS', async () => {
    const joinedAt = new Date('2026-08-01T10:00:00.000Z');
    profileFindUnique.mockResolvedValue({
      isLeft: false,
      leftAt: null,
      joinedAt,
    });

    const result = await finalizeLeaveRejoinState(claimedRequest(), GUILD, USER);

    expect(result).toEqual({ rejoined: false, profile: 'RESET', levelBaseline: false });
    expect(xpDeleteMany).toHaveBeenCalledWith({ where: { userId: 'internal-user', guildId: GUILD } });
    expect(levelDeleteMany).toHaveBeenCalledWith({ where: { userId: 'internal-user', guildId: GUILD } });
    expect(profileUpdateMany).toHaveBeenCalledWith({
      where: {
        guildId: GUILD,
        discordId: USER,
        isLeft: false,
        joinedAt,
        leftAt: null,
      },
      data: { messageCount: 0, isLeft: true, leftAt: CREATED },
    });
    expect(levelUpsert).not.toHaveBeenCalled();
  });

  it('preserves last-known goodbye identity and an existing leftAt while clearing historical state', async () => {
    const leftAt = new Date('2026-08-18T06:00:05.000Z');
    const joinedAt = new Date('2026-08-01T10:00:00.000Z');
    profileFindUnique.mockResolvedValue({
      isLeft: true,
      leftAt,
      joinedAt,
    });
    xpDeleteMany.mockResolvedValue({ count: 2 });
    levelDeleteMany.mockResolvedValue({ count: 1 });

    const result = await finalizeLeaveRejoinState(claimedRequest(), GUILD, USER);

    expect(result).toEqual({ rejoined: false, profile: 'RESET', levelBaseline: false });
    expect(profileUpdateMany).toHaveBeenCalledWith({
      where: {
        guildId: GUILD,
        discordId: USER,
        isLeft: true,
        joinedAt,
        leftAt,
      },
      data: { messageCount: 0, isLeft: true, leftAt },
    });
    expect(levelUpsert).not.toHaveBeenCalled();
  });

  it('retries instead of overwriting a concurrent rejoin that changes the previously read profile snapshot', async () => {
    const joinedAt = new Date('2026-08-01T10:00:00.000Z');
    profileFindUnique.mockResolvedValue({
      isLeft: true,
      leftAt: new Date('2026-08-18T06:00:05.000Z'),
      joinedAt,
    });
    profileUpdateMany.mockResolvedValue({ count: 0 });

    await expect(finalizeLeaveRejoinState(claimedRequest(), GUILD, USER))
      .rejects.toThrow(/Profil-CAS verloren/);

    expect(levelUpsert).not.toHaveBeenCalled();
  });

  it('returns NONE when no member profile exists and still removes late residual level state', async () => {
    profileFindUnique.mockResolvedValue(null);

    const result = await finalizeLeaveRejoinState(claimedRequest(), GUILD, USER);

    expect(result).toEqual({ rejoined: false, profile: 'NONE', levelBaseline: false });
    expect(xpDeleteMany).toHaveBeenCalledTimes(1);
    expect(levelDeleteMany).toHaveBeenCalledTimes(1);
    expect(profileUpdateMany).not.toHaveBeenCalled();
  });

  it('recognizes only joinedAt after the leave request as a genuine rejoin and restores a fresh baseline', async () => {
    const joinedAt = new Date('2026-08-18T06:05:00.000Z');
    profileFindUnique.mockResolvedValue({ isLeft: false, leftAt: null, joinedAt });

    const result = await finalizeLeaveRejoinState(claimedRequest(), GUILD, USER);

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

    await expect(finalizeLeaveRejoinState(claimedRequest(), GUILD, USER))
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

    await expect(finalizeLeaveRejoinState(claimedRequest(), GUILD, USER))
      .rejects.toThrow(/ohne User-Stammsatz/);

    expect(levelUpsert).not.toHaveBeenCalled();
  });
});
