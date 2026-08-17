const configFindUnique = jest.fn();
const configUpsert = jest.fn();
const deletionFindFirst = jest.fn();

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    botConfig: {
      findUnique: configFindUnique,
      upsert: configUpsert,
    },
    dataDeletionRequest: {
      findFirst: deletionFindFirst,
    },
  },
}));

import {
  getLeaveCleanupConfig,
  setLeaveCleanupConfig,
} from '../../src/modules/moderation/leaveCleanupConfig';
import {
  LeaveCleanupPendingError,
  assertNoOpenLeaveCleanupRequest,
  hasOpenLeaveCleanupRequest,
} from '../../src/modules/moderation/leaveCleanupGuard';

const GUILD_A = '12345678901234567';
const GUILD_B = '22345678901234567';
const USER = '32345678901234567';

beforeEach(() => {
  jest.clearAllMocks();
  configFindUnique.mockResolvedValue(null);
  configUpsert.mockResolvedValue({});
  deletionFindFirst.mockResolvedValue(null);
});

describe('Leave-1E guild-scoped config', () => {
  it('defaults destructive cleanup to OFF when no config exists', async () => {
    await expect(getLeaveCleanupConfig(GUILD_A)).resolves.toEqual({
      configured: false,
      deletePlayerDataOnLeave: false,
    });
    expect(configFindUnique).toHaveBeenCalledWith({ where: { key: `leave-cleanup:${GUILD_A}` } });
  });

  it('fails safe to OFF for malformed stored JSON instead of enabling deletion', async () => {
    for (const value of [null, true, 'yes', ['bad'], { deletePlayerDataOnLeave: 'true' }]) {
      configFindUnique.mockResolvedValueOnce({ value });
      await expect(getLeaveCleanupConfig(GUILD_A)).resolves.toMatchObject({
        configured: true,
        deletePlayerDataOnLeave: false,
      });
    }
  });

  it('persists the toggle only under the exact guild key with the actor as updater', async () => {
    await setLeaveCleanupConfig(GUILD_B, { deletePlayerDataOnLeave: true }, USER);

    expect(configUpsert).toHaveBeenCalledWith({
      where: { key: `leave-cleanup:${GUILD_B}` },
      create: expect.objectContaining({
        key: `leave-cleanup:${GUILD_B}`,
        value: { deletePlayerDataOnLeave: true },
        category: 'member-lifecycle',
        updatedBy: USER,
      }),
      update: {
        value: { deletePlayerDataOnLeave: true },
        updatedBy: USER,
      },
    });
  });
});

describe('Leave-1E open-cleanup relink guard', () => {
  it('looks only for the exact guild+Discord durable job key and active states', async () => {
    deletionFindFirst.mockResolvedValue({ id: 'job' });

    await expect(hasOpenLeaveCleanupRequest(GUILD_A, USER)).resolves.toBe(true);
    expect(deletionFindFirst).toHaveBeenCalledWith({
      where: {
        userId: `leave-job:v1:${GUILD_A}:${USER}`,
        requestType: 'PARTIAL_DELETION',
        status: { in: ['PENDING', 'IN_PROGRESS'] },
      },
      select: { id: true },
    });
  });

  it('throws the dedicated safe retry message while cleanup is still open', async () => {
    deletionFindFirst.mockResolvedValue({ id: 'job' });

    await expect(assertNoOpenLeaveCleanupRequest(GUILD_A, USER)).rejects.toBeInstanceOf(LeaveCleanupPendingError);
    await expect(assertNoOpenLeaveCleanupRequest(GUILD_A, USER)).rejects.toThrow(/noch abgeschlossen/);
  });

  it('allows relinking only after no PENDING/IN_PROGRESS job remains', async () => {
    deletionFindFirst.mockResolvedValue(null);
    await expect(assertNoOpenLeaveCleanupRequest(GUILD_A, USER)).resolves.toBeUndefined();
  });
});
