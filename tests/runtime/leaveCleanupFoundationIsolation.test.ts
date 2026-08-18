import fs from 'node:fs';
import path from 'node:path';

const read = (relative: string) => fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8');

const removeSource = read('src/events/guildMemberRemove.ts');
const readySource = read('src/events/ready.ts');
const sagaSource = read('src/modules/moderation/leaveCleanupSaga.ts');
const workerSource = read('src/modules/moderation/leaveCleanupWorker.ts');

describe('Leave-1A/1E durable production boundary', () => {
  it('wires guildMemberRemove only to guild-scoped config + durable enqueue, never destructive substeps', () => {
    expect(removeSource).toContain('getLeaveCleanupConfig');
    expect(removeSource).toContain('deletePlayerDataOnLeave');
    expect(removeSource).toContain('enqueueLeaveCleanupRequest');
    expect(removeSource).not.toContain('runLeaveWhitelistCleanupStep');
    expect(removeSource).not.toContain('runLeaveStatsSessionsCleanupStep');
    expect(removeSource).not.toContain('runLeaveLinkEconomy');
    expect(removeSource).not.toContain('cleanupGuildMemberData');
  });

  it('starts and stops the durable worker from the symmetric ClientReady lifecycle', () => {
    expect(readySource).toContain('startLeaveCleanupWorker');
    expect(readySource).toContain('await startLeaveCleanupWorker();');
    expect(readySource).toContain('stopLeaveCleanupWorker();');
  });

  it('persists checkpoints and processes every destructive domain only inside the worker', () => {
    expect(sagaSource).toContain("step: 'WHITELIST'");
    expect(sagaSource).toContain('advanceLeaveCleanupStep');
    expect(workerSource).toContain('runLeaveWhitelistCleanupStep');
    expect(workerSource).toContain('runLeaveStatsSessionsCleanupStep');
    expect(workerSource).toContain('runLeaveLinkEconomyAfterConfirmedWhitelistStep');
    expect(workerSource).toContain('cleanupGuildMemberData');
    expect(workerSource).toContain('completeLeaveCleanupRequest');
  });

  it('reuses the existing persistent DataDeletionRequest deletion queue instead of adding a parallel table', () => {
    expect(sagaSource).toContain('prisma.dataDeletionRequest');
    expect(sagaSource).not.toMatch(/prisma\.leaveCleanupJob/i);
  });
});
