const whitelistStep = jest.fn();
const statsStep = jest.fn();
const linkEconomyStep = jest.fn();
const guildDataStep = jest.fn();
const finalizeRejoin = jest.fn();
const claimNext = jest.fn();
const advanceStep = jest.fn();
const completeRequest = jest.fn();
const deferRequest = jest.fn();
const recoverStale = jest.fn();
const retryOrDead = jest.fn();

jest.mock('../../src/config', () => ({
  config: { security: { encryptionKey: '0123456789abcdef0123456789abcdef' } },
}));

jest.mock('../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('../../src/modules/moderation/leaveCleanupWhitelist', () => ({
  runLeaveWhitelistCleanupStep: whitelistStep,
}));

jest.mock('../../src/modules/moderation/leaveCleanupStatsSessions', () => ({
  runLeaveStatsSessionsCleanupStep: statsStep,
}));

jest.mock('../../src/modules/moderation/leaveCleanupLinkEconomy', () => ({
  runLeaveLinkEconomyAfterConfirmedWhitelistStep: linkEconomyStep,
}));

jest.mock('../../src/modules/moderation/guildMemberCleanup', () => ({
  cleanupGuildMemberData: guildDataStep,
}));

jest.mock('../../src/modules/moderation/leaveCleanupRejoin', () => ({
  finalizeLeaveRejoinState: finalizeRejoin,
}));

jest.mock('../../src/modules/moderation/leaveCleanupSecurity', () => ({
  sanitizeLeaveCleanupError: (error: unknown) => error instanceof Error ? error.message : String(error),
}));

jest.mock('../../src/modules/moderation/leaveCleanupSaga', () => ({
  claimNextLeaveCleanupRequest: claimNext,
  advanceLeaveCleanupStep: advanceStep,
  completeLeaveCleanupRequest: completeRequest,
  deferLeaveCleanupRequest: deferRequest,
  recoverStaleLeaveCleanupRequests: recoverStale,
  retryOrDeadLetterLeaveCleanupRequest: retryOrDead,
  leaveCleanupJobKey: (guildId: string, discordId: string) => `leave-job:v1:${guildId}:${discordId}`,
  readLeaveCleanupDetails: (value: unknown) => value,
}));

import {
  processLeaveCleanupRequest,
  runLeaveCleanupWorkerOnce,
  startLeaveCleanupWorker,
  stopLeaveCleanupWorker,
} from '../../src/modules/moderation/leaveCleanupWorker';

const GUILD = '12345678901234567';
const USER = '22345678901234567';
const JOB_KEY = `leave-job:v1:${GUILD}:${USER}`;
const INITIAL_LEASE = '2026-08-18T06:00:00.000Z';

function request(step: string, id = 'job-1') {
  return {
    id,
    userId: JOB_KEY,
    discordId: USER,
    status: 'IN_PROGRESS' as const,
    scheduledAt: new Date('2026-08-17T20:00:00.000Z'),
    details: {
      kind: 'GUILD_LEAVE_CLEANUP_V1',
      guildId: GUILD,
      step,
      stage: 'RUNNING',
      attempts: 0,
      maxAttempts: 8,
      claimToken: 'claim-token-1',
      claimedAt: INITIAL_LEASE,
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  whitelistStep.mockResolvedValue({ state: 'DONE' });
  statsStep.mockResolvedValue({ state: 'DONE' });
  linkEconomyStep.mockResolvedValue({ state: 'DONE' });
  guildDataStep.mockResolvedValue({ performed: true });
  finalizeRejoin.mockResolvedValue({ rejoined: false, profile: 'RESET', levelBaseline: false });
  completeRequest.mockResolvedValue('receipt');
  deferRequest.mockResolvedValue(undefined);
  recoverStale.mockResolvedValue(0);
  retryOrDead.mockResolvedValue('RETRY');
  claimNext.mockResolvedValue(null);
  advanceStep.mockImplementation(async (current: ReturnType<typeof request>, expected: string) => {
    const next: Record<string, string> = {
      WHITELIST: 'STATS_SESSIONS',
      STATS_SESSIONS: 'LINK_ECONOMY',
      LINK_ECONOMY: 'GUILD_DATA',
      GUILD_DATA: 'COMPLETE',
    };
    const lease: Record<string, string> = {
      WHITELIST: '2026-08-18T06:00:01.000Z',
      STATS_SESSIONS: '2026-08-18T06:00:02.000Z',
      LINK_ECONOMY: '2026-08-18T06:00:03.000Z',
      GUILD_DATA: '2026-08-18T06:00:04.000Z',
    };
    return {
      ...current,
      details: {
        ...current.details,
        step: next[expected],
        claimedAt: lease[expected],
      },
    };
  });
});

afterEach(() => {
  stopLeaveCleanupWorker();
  jest.useRealTimers();
});

describe('Leave-1E/1G durable worker', () => {
  it('runs strict substeps and gives each rejoin finalizer the currently renewed claim lease', async () => {
    const result = await processLeaveCleanupRequest(request('WHITELIST'));

    expect(result).toBe('COMPLETED');
    expect(whitelistStep).toHaveBeenCalledWith(GUILD, USER);
    expect(statsStep).toHaveBeenCalledWith(GUILD, USER);
    expect(linkEconomyStep).toHaveBeenCalledWith(GUILD, USER);
    expect(guildDataStep).toHaveBeenCalledWith(GUILD, USER);
    expect(advanceStep.mock.calls.map(call => call[1])).toEqual([
      'WHITELIST', 'STATS_SESSIONS', 'LINK_ECONOMY', 'GUILD_DATA',
    ]);
    expect(finalizeRejoin).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        id: 'job-1',
        details: expect.objectContaining({
          step: 'GUILD_DATA',
          claimToken: 'claim-token-1',
          claimedAt: '2026-08-18T06:00:03.000Z',
        }),
      }),
      GUILD,
      USER,
    );
    expect(finalizeRejoin).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        id: 'job-1',
        details: expect.objectContaining({
          step: 'COMPLETE',
          claimToken: 'claim-token-1',
          claimedAt: '2026-08-18T06:00:04.000Z',
        }),
      }),
      GUILD,
      USER,
    );
    expect(completeRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({
          step: 'COMPLETE',
          claimedAt: '2026-08-18T06:00:04.000Z',
        }),
      }),
      GUILD,
      '0123456789abcdef0123456789abcdef',
    );
  });

  it('fails closed before every destructive step when the persisted job key does not match guild+discord scope', async () => {
    const corrupted = {
      ...request('WHITELIST'),
      userId: `leave-job:v1:${GUILD}:99999999999999999`,
    };

    await expect(processLeaveCleanupRequest(corrupted)).rejects.toThrow(/Job-Key.*Guild\/User-Scope/);

    expect(whitelistStep).not.toHaveBeenCalled();
    expect(statsStep).not.toHaveBeenCalled();
    expect(linkEconomyStep).not.toHaveBeenCalled();
    expect(guildDataStep).not.toHaveBeenCalled();
    expect(finalizeRejoin).not.toHaveBeenCalled();
    expect(completeRequest).not.toHaveBeenCalled();
  });

  it('resumes directly at a persisted STATS_SESSIONS checkpoint after restart', async () => {
    await expect(processLeaveCleanupRequest(request('STATS_SESSIONS'))).resolves.toBe('COMPLETED');

    expect(whitelistStep).not.toHaveBeenCalled();
    expect(statsStep).toHaveBeenCalledTimes(1);
    expect(linkEconomyStep).toHaveBeenCalledTimes(1);
  });

  it('defers whitelist WAITING without running any later destructive step', async () => {
    whitelistStep.mockResolvedValue({ state: 'WAITING' });
    const current = request('WHITELIST');

    await expect(processLeaveCleanupRequest(current)).resolves.toBe('WAITING');

    expect(deferRequest).toHaveBeenCalledWith(current, 'WHITELIST_PENDING');
    expect(advanceStep).not.toHaveBeenCalled();
    expect(statsStep).not.toHaveBeenCalled();
    expect(linkEconomyStep).not.toHaveBeenCalled();
    expect(finalizeRejoin).not.toHaveBeenCalled();
  });

  it('defers an OPEN target session at STATS_SESSIONS and keeps 1C untouched', async () => {
    statsStep.mockResolvedValue({ state: 'WAITING', reason: 'ACTIVE_SESSION' });
    const current = request('STATS_SESSIONS');

    await expect(processLeaveCleanupRequest(current)).resolves.toBe('WAITING');

    expect(deferRequest).toHaveBeenCalledWith(current, 'ACTIVE_SESSION');
    expect(linkEconomyStep).not.toHaveBeenCalled();
    expect(guildDataStep).not.toHaveBeenCalled();
    expect(finalizeRejoin).not.toHaveBeenCalled();
  });

  it('defers an active lottery without consuming the link/economy checkpoint', async () => {
    linkEconomyStep.mockResolvedValue({ state: 'WAITING', reason: 'ACTIVE_LOTTERY' });
    const current = request('LINK_ECONOMY');

    await expect(processLeaveCleanupRequest(current)).resolves.toBe('WAITING');

    expect(deferRequest).toHaveBeenCalledWith(current, 'ACTIVE_LOTTERY');
    expect(guildDataStep).not.toHaveBeenCalled();
    expect(finalizeRejoin).not.toHaveBeenCalled();
    expect(completeRequest).not.toHaveBeenCalled();
  });

  it('retries with the latest persisted checkpoint instead of the initial request after a later substep fails', async () => {
    linkEconomyStep.mockRejectedValue(new Error('economy temporary'));
    const initial = request('WHITELIST');
    claimNext.mockResolvedValueOnce(initial).mockResolvedValueOnce(null);

    await expect(runLeaveCleanupWorkerOnce()).resolves.toBe(1);

    expect(advanceStep).toHaveBeenCalledTimes(2);
    expect(retryOrDead).toHaveBeenCalledTimes(1);
    const retried = retryOrDead.mock.calls[0][0];
    expect(retried.details.step).toBe('LINK_ECONOMY');
    expect(retried.details.claimedAt).toBe('2026-08-18T06:00:02.000Z');
    expect(retryOrDead.mock.calls[0][1]).toEqual(expect.objectContaining({ message: 'economy temporary' }));
  });

  it('treats guild-data transaction failure as a real retryable error before rejoin finalization', async () => {
    guildDataStep.mockResolvedValue({ performed: false, reason: 'transaction_failed' });
    const current = request('GUILD_DATA');
    claimNext.mockResolvedValueOnce(current).mockResolvedValueOnce(null);

    await runLeaveCleanupWorkerOnce();

    expect(deferRequest).not.toHaveBeenCalled();
    expect(finalizeRejoin).not.toHaveBeenCalled();
    expect(retryOrDead).toHaveBeenCalledWith(
      expect.objectContaining({ details: expect.objectContaining({ step: 'GUILD_DATA' }) }),
      expect.objectContaining({ message: expect.stringMatching(/Guild-Daten-Cleanup/) }),
    );
  });

  it('keeps GUILD_DATA retryable when rejoin finalization fails before the checkpoint advances', async () => {
    finalizeRejoin.mockRejectedValueOnce(new Error('rejoin race'));
    const current = request('GUILD_DATA');
    claimNext.mockResolvedValueOnce(current).mockResolvedValueOnce(null);

    await runLeaveCleanupWorkerOnce();

    expect(guildDataStep).toHaveBeenCalledTimes(1);
    expect(advanceStep).not.toHaveBeenCalled();
    expect(retryOrDead).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({ step: 'GUILD_DATA', claimedAt: INITIAL_LEASE }),
      }),
      expect.objectContaining({ message: 'rejoin race' }),
    );
  });

  it('rechecks rejoin state again immediately before COMPLETE receipt with the current lease snapshot', async () => {
    const current = request('COMPLETE');
    await expect(processLeaveCleanupRequest(current)).resolves.toBe('COMPLETED');

    expect(guildDataStep).not.toHaveBeenCalled();
    expect(finalizeRejoin).toHaveBeenCalledTimes(1);
    expect(finalizeRejoin).toHaveBeenCalledWith(current, GUILD, USER);
    expect(completeRequest).toHaveBeenCalledTimes(1);
  });

  it('performs stale recovery before starting the poll timer and can stop symmetrically', async () => {
    jest.useFakeTimers();
    recoverStale.mockResolvedValue(2);

    await startLeaveCleanupWorker();
    expect(recoverStale).toHaveBeenCalledTimes(1);

    stopLeaveCleanupWorker();
    jest.advanceTimersByTime(60_000);
    expect(claimNext).toHaveBeenCalledTimes(1); // initialer Tick; Recovery im Tick wird gedrosselt
  });
});
