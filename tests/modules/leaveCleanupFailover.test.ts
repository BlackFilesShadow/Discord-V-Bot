const claimNext = jest.fn();
const recoverStale = jest.fn();
const whitelistStep = jest.fn();
const statsStep = jest.fn();
const linkEconomyStep = jest.fn();
const guildDataStep = jest.fn();
const advanceStep = jest.fn();
const completeRequest = jest.fn();
const deferRequest = jest.fn();
const retryOrDead = jest.fn();
const errorLog = jest.fn();

jest.mock('../../src/config', () => ({
  config: { security: { encryptionKey: '0123456789abcdef0123456789abcdef' } },
}));

jest.mock('../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: errorLog },
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

jest.mock('../../src/modules/moderation/leaveCleanupSecurity', () => ({
  sanitizeLeaveCleanupError: (error: unknown) => error instanceof Error ? error.message : String(error),
}));

jest.mock('../../src/modules/moderation/leaveCleanupSaga', () => ({
  claimNextLeaveCleanupRequest: claimNext,
  recoverStaleLeaveCleanupRequests: recoverStale,
  advanceLeaveCleanupStep: advanceStep,
  completeLeaveCleanupRequest: completeRequest,
  deferLeaveCleanupRequest: deferRequest,
  retryOrDeadLetterLeaveCleanupRequest: retryOrDead,
  leaveCleanupJobKey: (guildId: string, discordId: string) => `leave-job:v1:${guildId}:${discordId}`,
  readLeaveCleanupDetails: (value: unknown) => value,
}));

import {
  runLeaveCleanupWorkerOnce,
  stopLeaveCleanupWorker,
} from '../../src/modules/moderation/leaveCleanupWorker';

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-08-18T06:00:00.000Z'));
  jest.clearAllMocks();
  stopLeaveCleanupWorker();
  recoverStale.mockResolvedValue(0);
  claimNext.mockResolvedValue(null);
});

afterEach(() => {
  stopLeaveCleanupWorker();
  jest.useRealTimers();
});

describe('Leave-1G multi-instance failover recovery', () => {
  it('runs recovery immediately, throttles it for one minute, then recovers again without restart', async () => {
    await expect(runLeaveCleanupWorkerOnce()).resolves.toBe(0);
    expect(recoverStale).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(59_999);
    await expect(runLeaveCleanupWorkerOnce()).resolves.toBe(0);
    expect(recoverStale).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(1);
    await expect(runLeaveCleanupWorkerOnce()).resolves.toBe(0);
    expect(recoverStale).toHaveBeenCalledTimes(2);
  });

  it('keeps normal pending-job polling available when a maintenance recovery attempt fails', async () => {
    recoverStale.mockRejectedValueOnce(new Error('db maintenance unavailable'));

    await expect(runLeaveCleanupWorkerOnce()).resolves.toBe(0);

    expect(claimNext).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledWith(expect.stringMatching(/Stale-Recovery fehlgeschlagen/));
  });
});
