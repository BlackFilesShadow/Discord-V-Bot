import fs from 'node:fs';
import path from 'node:path';

const read = (relative: string) => fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8');

const removeSource = read('src/events/guildMemberRemove.ts');
const workerSource = read('src/modules/moderation/leaveCleanupWorker.ts');
const cleanupSource = read('src/modules/moderation/leaveCleanupLinkEconomy.ts');

describe('Leave-1C/1E production ordering and reset invariants', () => {
  it('keeps link/economy mutation disconnected from guildMemberRemove', () => {
    expect(removeSource).not.toContain('leaveCleanupLinkEconomy');
    expect(removeSource).not.toContain('runLeaveLinkEconomyCleanupStep');
    expect(removeSource).not.toContain('runLeaveLinkEconomyAfterConfirmedWhitelistStep');
  });

  it('worker uses only the post-whitelist core after persistent stats completion', () => {
    expect(workerSource).toContain('runLeaveLinkEconomyAfterConfirmedWhitelistStep');
    expect(workerSource).not.toContain('runLeaveLinkEconomyCleanupStep');
    const statsAdvance = workerSource.indexOf("advanceLeaveCleanupStep(request, 'STATS_SESSIONS')");
    const economyCall = workerSource.indexOf('await runLeaveLinkEconomyAfterConfirmedWhitelistStep(');
    expect(statsAdvance).toBeGreaterThanOrEqual(0);
    expect(economyCall).toBeGreaterThan(statsAdvance);
  });

  it('keeps the standalone 1C wrapper protected by Leave-1B while exposing a separate orchestrator core', () => {
    const core = cleanupSource.indexOf('export async function runLeaveLinkEconomyAfterConfirmedWhitelistStep');
    const wrapper = cleanupSource.indexOf('export async function runLeaveLinkEconomyCleanupStep');
    const whitelistCall = cleanupSource.indexOf('runLeaveWhitelistCleanupStep', wrapper);
    expect(core).toBeGreaterThanOrEqual(0);
    expect(wrapper).toBeGreaterThan(core);
    expect(whitelistCall).toBeGreaterThan(wrapper);
    expect(cleanupSource).toContain("emptyWaiting(subjectKey, 'WHITELIST_PENDING')");
  });

  it('never resets or deletes PlayerSession anti-replay watermarks', () => {
    expect(cleanupSource).not.toContain('UPDATE "PlayerSession"');
    expect(cleanupSource).not.toContain('DELETE FROM "PlayerSession"');
    expect(cleanupSource).not.toContain('SET "bucketsCredited"');
    expect(cleanupSource).toContain('UPDATE "PlaytimeRewardProgress"');
  });

  it('blocks active lottery obligations before mutable account deletion', () => {
    const lotteryGate = cleanupSource.indexOf('if (await hasActiveLotteryObligation(');
    const accountDelete = cleanupSource.indexOf('DELETE FROM "EconomyAccount"');
    expect(lotteryGate).toBeGreaterThanOrEqual(0);
    expect(accountDelete).toBeGreaterThan(lotteryGate);
    expect(cleanupSource).toContain("emptyWaiting(subjectKey, 'ACTIVE_LOTTERY')");
  });

  it('pseudonymizes immutable history but deletes mutable account/link state only within guild+user scope', () => {
    expect(cleanupSource).toContain('replace("idempotencyKey", $2, $3)');
    expect(cleanupSource).toContain('UPDATE "RewardDecision"');
    expect(cleanupSource).toContain('UPDATE "EconomyTransaction"');
    expect(cleanupSource).toContain('DELETE FROM "EconomyAccount" WHERE "guildId"=$1 AND "userDiscordId"=$2');
    expect(cleanupSource).toContain('DELETE FROM "EconomyLinkRewardState" WHERE "guildId"=$1 AND "userDiscordId"=$2');
    expect(cleanupSource).toContain('DELETE FROM "GameIdentityLink" WHERE "guildId"=$1 AND "userDiscordId"=$2');
  });
});
