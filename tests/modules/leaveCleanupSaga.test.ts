const mockFindFirst = jest.fn();
const mockFindMany = jest.fn();
const mockCreate = jest.fn();
const mockUpdateMany = jest.fn();
const mockExecuteRaw = jest.fn().mockResolvedValue(1);
const mockTransaction = jest.fn();

const mockTx = {
  $executeRaw: mockExecuteRaw,
  dataDeletionRequest: {
    findFirst: mockFindFirst,
    create: mockCreate,
  },
};

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    $transaction: mockTransaction,
    dataDeletionRequest: {
      findFirst: mockFindFirst,
      findMany: mockFindMany,
      create: mockCreate,
      updateMany: mockUpdateMany,
    },
  },
}));

import {
  LEAVE_CLEANUP_KIND,
  claimNextLeaveCleanupRequest,
  completeLeaveCleanupRequest,
  enqueueLeaveCleanupRequest,
  hasCompletedLeaveCleanupReceipt,
  leaveCleanupBackoffMs,
  leaveCleanupJobKey,
  leaveCleanupReceiptFingerprint,
  recoverStaleLeaveCleanupRequests,
  retryOrDeadLetterLeaveCleanupRequest,
} from '../../src/modules/moderation/leaveCleanupSaga';

const GUILD_A = '12345678901234567';
const GUILD_B = '22345678901234567';
const USER = '32345678901234567';
const SECRET = 'x'.repeat(32);

beforeEach(() => {
  jest.clearAllMocks();
  mockFindFirst.mockResolvedValue(null);
  mockFindMany.mockResolvedValue([]);
  mockUpdateMany.mockResolvedValue({ count: 1 });
  mockExecuteRaw.mockResolvedValue(1);
  mockTransaction.mockImplementation(async (callback: (tx: typeof mockTx) => unknown) => callback(mockTx));
});

describe('Leave-1A durable cleanup saga foundation', () => {
  it('creates deterministic guild-scoped job keys and pseudonymous receipts', () => {
    expect(leaveCleanupJobKey(GUILD_A, USER)).toBe(`leave-job:v1:${GUILD_A}:${USER}`);
    const a1 = leaveCleanupReceiptFingerprint(GUILD_A, USER, SECRET);
    const a2 = leaveCleanupReceiptFingerprint(GUILD_A, USER, SECRET);
    const b = leaveCleanupReceiptFingerprint(GUILD_B, USER, SECRET);
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
    expect(a1).toMatch(/^leave-receipt:v1:[a-f0-9]{64}$/);
    expect(a1).not.toContain(USER);
  });

  it('refuses malformed ids and weak HMAC secrets', () => {
    expect(() => leaveCleanupJobKey('not-a-guild', USER)).toThrow(/Snowflake/);
    expect(() => leaveCleanupReceiptFingerprint(GUILD_A, USER, 'weak')).toThrow(/zu kurz/);
  });

  it('serializes concurrent enqueue for the same guild+user through a transaction advisory lock', async () => {
    mockFindFirst.mockResolvedValueOnce({ id: 'existing' });
    await expect(enqueueLeaveCleanupRequest({ guildId: GUILD_A, discordId: USER }))
      .resolves.toEqual({ id: 'existing', created: false });
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
    expect(mockFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ userId: `leave-job:v1:${GUILD_A}:${USER}` }),
    }));
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('persists a namespaced queued deletion request with bounded retries', async () => {
    mockCreate.mockResolvedValueOnce({ id: 'new-job' });
    const now = new Date('2026-08-17T18:00:00.000Z');
    await expect(enqueueLeaveCleanupRequest({ guildId: GUILD_A, discordId: USER, now, maxAttempts: 999 }))
      .resolves.toEqual({ id: 'new-job', created: true });
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        userId: `leave-job:v1:${GUILD_A}:${USER}`,
        discordId: USER,
        requestType: 'PARTIAL_DELETION',
        status: 'PENDING',
        scheduledAt: now,
        details: expect.objectContaining({
          kind: LEAVE_CLEANUP_KIND,
          guildId: GUILD_A,
          stage: 'QUEUED',
          attempts: 0,
          maxAttempts: 32,
        }),
      }),
    }));
  });

  it('claims pending work through a PENDING -> IN_PROGRESS CAS', async () => {
    const now = new Date('2026-08-17T18:00:00.000Z');
    mockFindFirst.mockResolvedValueOnce({
      id: 'job-1',
      userId: `leave-job:v1:${GUILD_A}:${USER}`,
      discordId: USER,
      status: 'PENDING',
      scheduledAt: now,
      details: { kind: LEAVE_CLEANUP_KIND, guildId: GUILD_A, stage: 'QUEUED', attempts: 0, maxAttempts: 8 },
    });

    const claimed = await claimNextLeaveCleanupRequest(now);
    expect(claimed?.status).toBe('IN_PROGRESS');
    expect(mockUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'job-1', status: 'PENDING' },
      data: expect.objectContaining({ status: 'IN_PROGRESS' }),
    }));
  });

  it('recovers only stale in-progress claims after a restart', async () => {
    const now = new Date('2026-08-17T18:10:00.000Z');
    mockFindMany.mockResolvedValueOnce([
      {
        id: 'stale',
        details: { kind: LEAVE_CLEANUP_KIND, guildId: GUILD_A, stage: 'RUNNING', attempts: 1, maxAttempts: 8, claimedAt: '2026-08-17T18:00:00.000Z' },
      },
      {
        id: 'fresh',
        details: { kind: LEAVE_CLEANUP_KIND, guildId: GUILD_A, stage: 'RUNNING', attempts: 1, maxAttempts: 8, claimedAt: '2026-08-17T18:09:30.000Z' },
      },
    ]);
    await expect(recoverStaleLeaveCleanupRequests(now, 60_000)).resolves.toBe(1);
    expect(mockUpdateMany).toHaveBeenCalledTimes(1);
    expect(mockUpdateMany.mock.calls[0][0].where).toEqual({ id: 'stale', status: 'IN_PROGRESS' });
    expect(mockUpdateMany.mock.calls[0][0].data.details).not.toHaveProperty('claimedAt');
  });

  it('uses bounded exponential backoff and transitions to retry without undefined JSON fields', async () => {
    expect(leaveCleanupBackoffMs(1)).toBe(5_000);
    expect(leaveCleanupBackoffMs(2)).toBe(10_000);
    expect(leaveCleanupBackoffMs(99)).toBe(60 * 60_000);

    const now = new Date('2026-08-17T18:00:00.000Z');
    const request = {
      id: 'job-r',
      userId: `leave-job:v1:${GUILD_A}:${USER}`,
      discordId: USER,
      status: 'IN_PROGRESS' as const,
      scheduledAt: now,
      details: { kind: LEAVE_CLEANUP_KIND, guildId: GUILD_A, stage: 'RUNNING' as const, attempts: 0, maxAttempts: 3, claimedAt: now.toISOString() },
    };
    await expect(retryOrDeadLetterLeaveCleanupRequest(request, new Error('temporary\nsecret-ish'), now)).resolves.toBe('RETRY');
    expect(mockUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'job-r', status: 'IN_PROGRESS' },
      data: expect.objectContaining({
        status: 'PENDING',
        scheduledAt: new Date('2026-08-17T18:00:05.000Z'),
        details: expect.objectContaining({ attempts: 1, stage: 'RETRY_WAIT', lastError: 'temporary secret-ish' }),
      }),
    }));
    expect(mockUpdateMany.mock.calls[0][0].data.details).not.toHaveProperty('claimedAt');
  });

  it('dead-letters at maxAttempts instead of retrying forever', async () => {
    const now = new Date('2026-08-17T18:00:00.000Z');
    const request = {
      id: 'job-d',
      userId: `leave-job:v1:${GUILD_A}:${USER}`,
      discordId: USER,
      status: 'IN_PROGRESS' as const,
      scheduledAt: now,
      details: { kind: LEAVE_CLEANUP_KIND, guildId: GUILD_A, stage: 'RUNNING' as const, attempts: 2, maxAttempts: 3 },
    };
    await expect(retryOrDeadLetterLeaveCleanupRequest(request, 'fatal', now)).resolves.toBe('DEAD');
    expect(mockUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'FAILED', details: expect.objectContaining({ attempts: 3, stage: 'DEAD' }) }),
    }));
  });

  it('anonymizes raw processing ids when the saga is completed', async () => {
    const now = new Date('2026-08-17T18:00:00.000Z');
    const request = {
      id: 'job-c',
      userId: `leave-job:v1:${GUILD_A}:${USER}`,
      discordId: USER,
      status: 'IN_PROGRESS' as const,
      scheduledAt: now,
      details: { kind: LEAVE_CLEANUP_KIND, guildId: GUILD_A, stage: 'RUNNING' as const, attempts: 1, maxAttempts: 8, claimedAt: now.toISOString(), lastError: 'old' },
    };
    const fingerprint = await completeLeaveCleanupRequest(request, GUILD_A, SECRET, now);
    expect(fingerprint).not.toContain(USER);
    expect(mockUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'job-c', status: 'IN_PROGRESS', userId: request.userId },
      data: expect.objectContaining({
        status: 'COMPLETED',
        completedAt: now,
        userId: fingerprint,
        discordId: fingerprint,
        details: expect.objectContaining({ stage: 'COMPLETED', completedAt: now.toISOString() }),
      }),
    }));
    expect(mockUpdateMany.mock.calls[0][0].data.details).not.toHaveProperty('claimedAt');
    expect(mockUpdateMany.mock.calls[0][0].data.details).not.toHaveProperty('lastError');
  });

  it('looks up completed anti-churn receipts only through the pseudonymous fingerprint', async () => {
    mockFindFirst.mockResolvedValueOnce({ id: 'receipt' });
    await expect(hasCompletedLeaveCleanupReceipt(GUILD_A, USER, SECRET)).resolves.toBe(true);
    const fingerprint = leaveCleanupReceiptFingerprint(GUILD_A, USER, SECRET);
    expect(mockFindFirst).toHaveBeenCalledWith({
      where: {
        userId: fingerprint,
        discordId: fingerprint,
        requestType: 'PARTIAL_DELETION',
        status: 'COMPLETED',
      },
      select: { id: true },
    });
  });
});
