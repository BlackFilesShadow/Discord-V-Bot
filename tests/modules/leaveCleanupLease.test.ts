const queryRaw = jest.fn();

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    $queryRawUnsafe: queryRaw,
  },
}));

jest.mock('../../src/modules/moderation/leaveCleanupSaga', () => ({
  leaveCleanupJobKey: (guildId: string, discordId: string) => `leave-job:v1:${guildId}:${discordId}`,
  readLeaveCleanupDetails: (value: unknown) => value,
}));

import { renewLeaveCleanupClaimLease } from '../../src/modules/moderation/leaveCleanupLease';

const GUILD = '12345678901234567';
const USER = '22345678901234567';
const JOB_KEY = `leave-job:v1:${GUILD}:${USER}`;
const CLAIMED_AT = '2026-08-18T06:00:00.000Z';

function request(details: Record<string, unknown> = {}) {
  return {
    id: 'job-1',
    userId: JOB_KEY,
    discordId: USER,
    status: 'IN_PROGRESS' as const,
    scheduledAt: new Date('2026-08-18T06:00:00.000Z'),
    details: {
      kind: 'GUILD_LEAVE_CLEANUP_V1',
      guildId: GUILD,
      step: 'LINK_ECONOMY',
      stage: 'RUNNING',
      attempts: 0,
      maxAttempts: 8,
      claimToken: 'token-a',
      claimedAt: CLAIMED_AT,
      ...details,
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  queryRaw.mockResolvedValue([{ id: 'job-1' }]);
});

describe('Leave-1G claim lease heartbeat', () => {
  it('renews a modern claim only with token + exact previous claimedAt', async () => {
    const result = await renewLeaveCleanupClaimLease(
      request(),
      GUILD,
      USER,
      new Date('2026-08-18T06:01:00.000Z'),
    );

    expect(result.details).toEqual(expect.objectContaining({
      claimToken: 'token-a',
      claimedAt: '2026-08-18T06:01:00.000Z',
      step: 'LINK_ECONOMY',
    }));
    const call = queryRaw.mock.calls[0];
    expect(String(call[0])).toContain("jsonb_extract_path_text(\"details\", 'claimToken')=$4");
    expect(String(call[0])).toContain("jsonb_extract_path_text(\"details\", 'claimedAt')=$5");
    expect(call.slice(1)).toEqual([
      'job-1',
      JOB_KEY,
      USER,
      'token-a',
      CLAIMED_AT,
      '2026-08-18T06:01:00.000Z',
    ]);
  });

  it('keeps legacy in-flight claims compatible through claimedAt-only CAS', async () => {
    const legacy = request({ claimToken: undefined });

    const result = await renewLeaveCleanupClaimLease(
      legacy,
      GUILD,
      USER,
      new Date('2026-08-18T06:01:00.000Z'),
    );

    expect(result.details).toEqual(expect.objectContaining({
      claimToken: undefined,
      claimedAt: '2026-08-18T06:01:00.000Z',
    }));
    const call = queryRaw.mock.calls[0];
    expect(String(call[0])).not.toContain("'claimToken'");
    expect(String(call[0])).toContain("jsonb_extract_path_text(\"details\", 'claimedAt')=$4");
    expect(call.slice(1)).toEqual([
      'job-1',
      JOB_KEY,
      USER,
      CLAIMED_AT,
      '2026-08-18T06:01:00.000Z',
    ]);
  });

  it('forces claimedAt to move forward even if the supplied clock has not advanced', async () => {
    const result = await renewLeaveCleanupClaimLease(
      request(),
      GUILD,
      USER,
      new Date(CLAIMED_AT),
    );

    expect((result.details as { claimedAt: string }).claimedAt).toBe('2026-08-18T06:00:00.001Z');
    expect(queryRaw.mock.calls[0][6]).toBe('2026-08-18T06:00:00.001Z');
  });

  it('fails closed when another instance already renewed or reclaimed the snapshot', async () => {
    queryRaw.mockResolvedValue([]);

    await expect(renewLeaveCleanupClaimLease(
      request(),
      GUILD,
      USER,
      new Date('2026-08-18T06:01:00.000Z'),
    )).rejects.toThrow(/Lease-CAS verloren/);
  });

  it('rejects invalid scope or missing/invalid lease before touching the database', async () => {
    await expect(renewLeaveCleanupClaimLease(
      { ...request(), userId: `leave-job:v1:${GUILD}:99999999999999999` },
      GUILD,
      USER,
    )).rejects.toThrow(/Request\/Scope/);

    await expect(renewLeaveCleanupClaimLease(
      request({ claimedAt: undefined }),
      GUILD,
      USER,
    )).rejects.toThrow(/claimedAt fehlt/);

    await expect(renewLeaveCleanupClaimLease(
      request({ claimedAt: 'not-a-date' }),
      GUILD,
      USER,
    )).rejects.toThrow(/claimedAt ist ungueltig/);

    expect(queryRaw).not.toHaveBeenCalled();
  });
});
