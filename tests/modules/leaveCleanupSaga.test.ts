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
  advanceLeaveCleanupStep,
  claimNextLeaveCleanupRequest,
  completeLeaveCleanupRequest,
  deferLeaveCleanupRequest,
  enqueueLeaveCleanupRequest,
  hasCompletedLeaveCleanupReceipt,
  leaveCleanupBackoffMs,
  leaveCleanupJobKey,
  leaveCleanupReceiptFingerprint,
  readLeaveCleanupDetails,
  recoverStaleLeaveCleanupRequests,
  retryOrDeadLetterLeaveCleanupRequest,
} from '../../src/modules/moderation/leaveCleanupSaga';

const GUILD_A = '12345678901234567';
const GUILD_B = '22345678901234567';
const USER = '32345678901234567';
const SECRET = 'x'.repeat(32);
const CLAIM_TOKEN = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  jest.clearAllMocks();
  mockFindFirst.mockResolvedValue(null);
  mockFindMany.mockResolvedValue([]);
  mockUpdateMany.mockResolvedValue({ count: 1 });
  mockExecuteRaw.mockResolvedValue(1);
  mockTransaction.mockImplementation(async (callback: (tx: typeof mockTx) => unknown) => callback(mockTx));
});

describe('Leave-1A/1E/1F durable cleanup saga', () => {
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

  it('treats legacy Leave-1A rows without a step or claim token as WHITELIST for safe upgrade continuity', () => {
    const details = readLeaveCleanupDetails({
      kind: LEAVE_CLEANUP_KIND,
      guildId: GUILD_A,
      stage: 'QUEUED',
      attempts: 0,
      maxAttempts: 8,
    });
    expect(details).toMatchObject({ step: 'WHITELIST', stage: 'QUEUED', attempts: 0 });
    expect(details).not.toHaveProperty('claimToken');
  });

  it('serializes concurrent enqueue for the same guild+user through a transaction advisory lock', async () => {
    mockFindFirst.mockResolvedValueOnce({ id: 'existing' });
    await expect(enqueueLeaveCleanupRequest({ guildId: GUILD_A, discordId: USER }))
      .resolves.toEqual({ id: 'existing', created: false });
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
    expect(mockFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        userId: `leave-job:v1:${GUILD_A}:${USER}`,
        status: { in: ['PENDING', 'IN_PROGRESS', 'FAILED'] },
      }),
    }));
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('does not create a parallel cleanup when the previous exact job is dead-lettered', async () => {
    mockFindFirst.mockResolvedValueOnce({ id: 'dead-job' });

    await expect(enqueueLeaveCleanupRequest({ guildId: GUILD_A, discordId: USER }))
      .resolves.toEqual({ id: 'dead-job', created: false });

    expect(mockFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        userId: `leave-job:v1:${GUILD_A}:${USER}`,
        requestType: 'PARTIAL_DELETION',
        status: { in: ['PENDING', 'IN_PROGRESS', 'FAILED'] },
      }),
    }));
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('persists a namespaced queued deletion request at the WHITELIST checkpoint with bounded retries', async () => {
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
          step: 'WHITELIST',
          stage: 'QUEUED',
          attempts: 0,
          maxAttempts: 32,
        }),
      }),
    }));
  });

  it('claims pending work with a fresh UUID fence and upgrades legacy step metadata', async () => {
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
    const claimedDetails = readLeaveCleanupDetails(claimed?.details);
    expect(claimed?.status).toBe('IN_PROGRESS');
    expect(claimedDetails?.step).toBe('WHITELIST');
    expect(claimedDetails?.claimedAt).toBe(now.toISOString());
    expect(claimedDetails?.claimToken).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(mockUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'job-1', status: 'PENDING' },
      data: expect.objectContaining({
        status: 'IN_PROGRESS',
        details: expect.objectContaining({ step: 'WHITELIST', stage: 'RUNNING', claimToken: expect.any(String) }),
      }),
    }));
  });

  it('dead-letters a pending row whose raw job key does not match its persisted guild+discord scope', async () => {
    const now = new Date('2026-08-17T18:00:00.000Z');
    mockFindFirst.mockResolvedValueOnce({
      id: 'job-corrupt',
      userId: `leave-job:v1:${GUILD_B}:${USER}`,
      discordId: USER,
      status: 'PENDING',
      scheduledAt: now,
      details: {
        kind: LEAVE_CLEANUP_KIND,
        guildId: GUILD_A,
        step: 'WHITELIST',
        stage: 'QUEUED',
        attempts: 0,
        maxAttempts: 8,
      },
    });

    await expect(claimNextLeaveCleanupRequest(now)).resolves.toBeNull();

    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: { id: 'job-corrupt', status: 'PENDING' },
      data: {
        status: 'FAILED',
        details: expect.objectContaining({
          guildId: GUILD_A,
          step: 'WHITELIST',
          stage: 'DEAD',
          lastError: expect.stringMatching(/Scope-Zuordnung/),
        }),
      },
    });
  });

  it('persists successful substep transitions only for the active claim fence', async () => {
    const now = new Date('2026-08-17T18:00:00.000Z');
    const request = {
      id: 'job-step',
      userId: `leave-job:v1:${GUILD_A}:${USER}`,
      discordId: USER,
      status: 'IN_PROGRESS' as const,
      scheduledAt: now,
      details: {
        kind: LEAVE_CLEANUP_KIND,
        guildId: GUILD_A,
        step: 'WHITELIST' as const,
        stage: 'RUNNING' as const,
        attempts: 2,
        maxAttempts: 8,
        claimedAt: now.toISOString(),
        claimToken: CLAIM_TOKEN,
      },
    };

    const next = await advanceLeaveCleanupStep(request, 'WHITELIST');
    expect(readLeaveCleanupDetails(next.details)).toMatchObject({
      step: 'STATS_SESSIONS',
      stage: 'RUNNING',
      attempts: 2,
      claimToken: CLAIM_TOKEN,
    });
    expect(mockUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: 'job-step',
        status: 'IN_PROGRESS',
        userId: request.userId,
        details: { path: ['claimToken'], equals: CLAIM_TOKEN },
      },
      data: { details: expect.objectContaining({ step: 'STATS_SESSIONS', attempts: 2, claimToken: CLAIM_TOKEN }) },
    }));
  });

  it('rejects a stale worker that lost its claim fence instead of regressing a newer checkpoint', async () => {
    const now = new Date('2026-08-17T18:00:00.000Z');
    const staleRequest = {
      id: 'job-stale-writer',
      userId: `leave-job:v1:${GUILD_A}:${USER}`,
      discordId: USER,
      status: 'IN_PROGRESS' as const,
      scheduledAt: now,
      details: {
        kind: LEAVE_CLEANUP_KIND,
        guildId: GUILD_A,
        step: 'STATS_SESSIONS' as const,
        stage: 'RUNNING' as const,
        attempts: 0,
        maxAttempts: 8,
        claimedAt: now.toISOString(),
        claimToken: CLAIM_TOKEN,
      },
    };
    mockUpdateMany.mockResolvedValueOnce({ count: 0 });

    await expect(advanceLeaveCleanupStep(staleRequest, 'STATS_SESSIONS')).rejects.toThrow(/Step-CAS verloren/);
    expect(mockUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: 'job-stale-writer',
        status: 'IN_PROGRESS',
        details: { path: ['claimToken'], equals: CLAIM_TOKEN },
      }),
    }));
  });

  it('defers normal WAITING without consuming attempts and removes the released claim lease', async () => {
    const now = new Date('2026-08-17T18:00:00.000Z');
    const request = {
      id: 'job-wait',
      userId: `leave-job:v1:${GUILD_A}:${USER}`,
      discordId: USER,
      status: 'IN_PROGRESS' as const,
      scheduledAt: now,
      details: {
        kind: LEAVE_CLEANUP_KIND,
        guildId: GUILD_A,
        step: 'STATS_SESSIONS' as const,
        stage: 'RUNNING' as const,
        attempts: 3,
        maxAttempts: 8,
        claimedAt: now.toISOString(),
        claimToken: CLAIM_TOKEN,
      },
    };

    await deferLeaveCleanupRequest(request, 'ACTIVE_SESSION', now, 30_000);
    expect(mockUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: 'job-wait',
        status: 'IN_PROGRESS',
        userId: request.userId,
        details: { path: ['claimToken'], equals: CLAIM_TOKEN },
      },
      data: expect.objectContaining({
        status: 'PENDING',
        scheduledAt: new Date('2026-08-17T18:00:30.000Z'),
        details: expect.objectContaining({
          step: 'STATS_SESSIONS',
          stage: 'RETRY_WAIT',
          attempts: 3,
          lastError: 'ACTIVE_SESSION',
        }),
      }),
    }));
    expect(mockUpdateMany.mock.calls[0][0].data.details).not.toHaveProperty('claimedAt');
    expect(mockUpdateMany.mock.calls[0][0].data.details).not.toHaveProperty('claimToken');
  });

  it('recovers only the exact stale claim token and preserves its checkpoint', async () => {
    const now = new Date('2026-08-17T18:10:00.000Z');
    mockFindMany.mockResolvedValueOnce([
      {
        id: 'stale',
        details: { kind: LEAVE_CLEANUP_KIND, guildId: GUILD_A, step: 'LINK_ECONOMY', stage: 'RUNNING', attempts: 1, maxAttempts: 8, claimedAt: '2026-08-17T18:00:00.000Z', claimToken: CLAIM_TOKEN },
      },
      {
        id: 'fresh',
        details: { kind: LEAVE_CLEANUP_KIND, guildId: GUILD_A, step: 'STATS_SESSIONS', stage: 'RUNNING', attempts: 1, maxAttempts: 8, claimedAt: '2026-08-17T18:09:30.000Z', claimToken: '22222222-2222-4222-8222-222222222222' },
      },
    ]);
    await expect(recoverStaleLeaveCleanupRequests(now, 60_000)).resolves.toBe(1);
    expect(mockUpdateMany).toHaveBeenCalledTimes(1);
    expect(mockUpdateMany.mock.calls[0][0].where).toEqual({
      id: 'stale',
      status: 'IN_PROGRESS',
      details: { path: ['claimToken'], equals: CLAIM_TOKEN },
    });
    expect(mockUpdateMany.mock.calls[0][0].data.details).toMatchObject({ step: 'LINK_ECONOMY', stage: 'QUEUED' });
    expect(mockUpdateMany.mock.calls[0][0].data.details).not.toHaveProperty('claimedAt');
    expect(mockUpdateMany.mock.calls[0][0].data.details).not.toHaveProperty('claimToken');
  });

  it('paginates restart recovery beyond 500 and fences a legacy claim by claimedAt', async () => {
    const now = new Date('2026-08-17T18:10:00.000Z');
    const freshBatch = Array.from({ length: 500 }, (_, index) => ({
      id: String(index).padStart(4, '0'),
      details: {
        kind: LEAVE_CLEANUP_KIND,
        guildId: GUILD_A,
        step: 'STATS_SESSIONS',
        stage: 'RUNNING',
        attempts: 1,
        maxAttempts: 8,
        claimedAt: '2026-08-17T18:09:30.000Z',
      },
    }));
    mockFindMany
      .mockResolvedValueOnce(freshBatch)
      .mockResolvedValueOnce([
        {
          id: '0500',
          details: {
            kind: LEAVE_CLEANUP_KIND,
            guildId: GUILD_A,
            step: 'LINK_ECONOMY',
            stage: 'RUNNING',
            attempts: 1,
            maxAttempts: 8,
            claimedAt: '2026-08-17T18:00:00.000Z',
          },
        },
      ]);

    await expect(recoverStaleLeaveCleanupRequests(now, 60_000)).resolves.toBe(1);

    expect(mockFindMany).toHaveBeenCalledTimes(2);
    expect(mockFindMany.mock.calls[1][0]).toEqual(expect.objectContaining({
      where: expect.objectContaining({ id: { gt: '0499' } }),
      orderBy: { id: 'asc' },
      take: 500,
    }));
    expect(mockUpdateMany).toHaveBeenCalledTimes(1);
    expect(mockUpdateMany.mock.calls[0][0].where).toEqual({
      id: '0500',
      status: 'IN_PROGRESS',
      details: { path: ['claimedAt'], equals: '2026-08-17T18:00:00.000Z' },
    });
  });

  it('uses bounded exponential backoff and fences retry persistence to the active claim', async () => {
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
      details: { kind: LEAVE_CLEANUP_KIND, guildId: GUILD_A, step: 'LINK_ECONOMY' as const, stage: 'RUNNING' as const, attempts: 0, maxAttempts: 3, claimedAt: now.toISOString(), claimToken: CLAIM_TOKEN },
    };
    await expect(retryOrDeadLetterLeaveCleanupRequest(request, new Error('temporary\nsecret-ish'), now)).resolves.toBe('RETRY');
    expect(mockUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: 'job-r',
        status: 'IN_PROGRESS',
        userId: request.userId,
        details: { path: ['claimToken'], equals: CLAIM_TOKEN },
      },
      data: expect.objectContaining({
        status: 'PENDING',
        scheduledAt: new Date('2026-08-17T18:00:05.000Z'),
        details: expect.objectContaining({ step: 'LINK_ECONOMY', attempts: 1, stage: 'RETRY_WAIT', lastError: 'temporary secret-ish' }),
      }),
    }));
    expect(mockUpdateMany.mock.calls[0][0].data.details).not.toHaveProperty('claimedAt');
    expect(mockUpdateMany.mock.calls[0][0].data.details).not.toHaveProperty('claimToken');
  });

  it('dead-letters at maxAttempts only through the active claim fence', async () => {
    const now = new Date('2026-08-17T18:00:00.000Z');
    const request = {
      id: 'job-d',
      userId: `leave-job:v1:${GUILD_A}:${USER}`,
      discordId: USER,
      status: 'IN_PROGRESS' as const,
      scheduledAt: now,
      details: { kind: LEAVE_CLEANUP_KIND, guildId: GUILD_A, step: 'GUILD_DATA' as const, stage: 'RUNNING' as const, attempts: 2, maxAttempts: 3, claimedAt: now.toISOString(), claimToken: CLAIM_TOKEN },
    };
    await expect(retryOrDeadLetterLeaveCleanupRequest(request, 'fatal', now)).resolves.toBe('DEAD');
    expect(mockUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ details: { path: ['claimToken'], equals: CLAIM_TOKEN } }),
      data: expect.objectContaining({ status: 'FAILED', details: expect.objectContaining({ step: 'GUILD_DATA', attempts: 3, stage: 'DEAD' }) }),
    }));
  });

  it('refuses completion before the persisted COMPLETE checkpoint', async () => {
    const now = new Date('2026-08-17T18:00:00.000Z');
    const request = {
      id: 'job-early',
      userId: `leave-job:v1:${GUILD_A}:${USER}`,
      discordId: USER,
      status: 'IN_PROGRESS' as const,
      scheduledAt: now,
      details: { kind: LEAVE_CLEANUP_KIND, guildId: GUILD_A, step: 'GUILD_DATA' as const, stage: 'RUNNING' as const, attempts: 0, maxAttempts: 8 },
    };
    await expect(completeLeaveCleanupRequest(request, GUILD_A, SECRET, now)).rejects.toThrow(/Step GUILD_DATA/);
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it('anonymizes raw processing ids only after COMPLETE and only through the active claim fence', async () => {
    const now = new Date('2026-08-17T18:00:00.000Z');
    const request = {
      id: 'job-c',
      userId: `leave-job:v1:${GUILD_A}:${USER}`,
      discordId: USER,
      status: 'IN_PROGRESS' as const,
      scheduledAt: now,
      details: { kind: LEAVE_CLEANUP_KIND, guildId: GUILD_A, step: 'COMPLETE' as const, stage: 'RUNNING' as const, attempts: 1, maxAttempts: 8, claimedAt: now.toISOString(), claimToken: CLAIM_TOKEN, lastError: 'old' },
    };
    const fingerprint = await completeLeaveCleanupRequest(request, GUILD_A, SECRET, now);
    expect(fingerprint).not.toContain(USER);
    expect(mockUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: 'job-c',
        status: 'IN_PROGRESS',
        userId: request.userId,
        details: { path: ['claimToken'], equals: CLAIM_TOKEN },
      },
      data: expect.objectContaining({
        status: 'COMPLETED',
        completedAt: now,
        userId: fingerprint,
        discordId: fingerprint,
        details: expect.objectContaining({ step: 'COMPLETE', stage: 'COMPLETED', completedAt: now.toISOString() }),
      }),
    }));
    expect(mockUpdateMany.mock.calls[0][0].data.details).not.toHaveProperty('claimedAt');
    expect(mockUpdateMany.mock.calls[0][0].data.details).not.toHaveProperty('claimToken');
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