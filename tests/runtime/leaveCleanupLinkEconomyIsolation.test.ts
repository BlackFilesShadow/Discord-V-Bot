import fs from 'node:fs';
import path from 'node:path';

const read = (relative: string) => fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8');

const removeSource = read('src/events/guildMemberRemove.ts');
const indexSource = read('src/index.ts');
const cleanupSource = read('src/modules/moderation/leaveCleanupLinkEconomy.ts');

describe('Leave-1C production isolation and reset invariants', () => {
  it('keeps link/economy cleanup disconnected from guildMemberRemove until the full saga is complete', () => {
    expect(removeSource).not.toContain('leaveCleanupLinkEconomy');
    expect(removeSource).not.toContain('runLeaveLinkEconomyCleanupStep');
  });

  it('does not start the incomplete cleanup processor from process runtime', () => {
    expect(indexSource).not.toContain('runLeaveLinkEconomyCleanupStep');
    expect(indexSource).not.toContain('startLeaveCleanup');
  });

  it('requires Leave-1B whitelist completion before any economy mutation', () => {
    const whitelist = cleanupSource.indexOf('runLeaveWhitelistCleanupStep');
    const transaction = cleanupSource.indexOf('prisma.$transaction');
    expect(whitelist).toBeGreaterThanOrEqual(0);
    expect(transaction).toBeGreaterThan(whitelist);
    expect(cleanupSource).toContain("reason: 'WHITELIST_PENDING'");
  });

  it('never resets or deletes PlayerSession anti-replay watermarks', () => {
    expect(cleanupSource).not.toContain('UPDATE "PlayerSession"');
    expect(cleanupSource).not.toContain('DELETE FROM "PlayerSession"');
    expect(cleanupSource).not.toContain('SET "bucketsCredited"');
    expect(cleanupSource).toContain('UPDATE "PlaytimeRewardProgress"');
  });

  it('blocks active lottery obligations before mutable account deletion', () => {
    const lotteryGate = cleanupSource.indexOf('hasActiveLotteryObligation');
    const accountDelete = cleanupSource.indexOf('DELETE FROM "EconomyAccount"');
    expect(lotteryGate).toBeGreaterThanOrEqual(0);
    expect(accountDelete).toBeGreaterThan(lotteryGate);
    expect(cleanupSource).toContain("reason: 'ACTIVE_LOTTERY'");
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
