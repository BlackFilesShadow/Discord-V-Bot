import fs from 'node:fs';
import path from 'node:path';

const migration = fs.readFileSync(
  path.resolve(process.cwd(), 'prisma/migrations/20260816042000_link_reward_cutoff_startbalance/migration.sql'),
  'utf8',
);
const cleanup = fs.readFileSync(
  path.resolve(process.cwd(), 'src/modules/moderation/leaveCleanupLinkEconomy.ts'),
  'utf8',
);

describe('Leave-1C production migration contract', () => {
  it('pins EconomyLinkRewardState columns used by destructive cleanup', () => {
    expect(migration).toContain('CREATE TABLE "EconomyLinkRewardState"');
    for (const column of ['"guildId"', '"nitradoConnId"', '"userDiscordId"', '"rewardEligibleFrom"', '"startBalanceEligible"']) {
      expect(migration).toContain(column);
    }
    expect(cleanup).toContain('DELETE FROM "EconomyLinkRewardState"');
  });

  it('pins PlaytimeRewardProgress anti-replay columns and never mutates their watermark fields', () => {
    expect(migration).toContain('CREATE TABLE "PlaytimeRewardProgress"');
    expect(migration).toContain('"rewardEpoch" TIMESTAMP(3) NOT NULL');
    expect(migration).toContain('"bucketsCredited" INTEGER NOT NULL DEFAULT 0');
    expect(cleanup).toContain('UPDATE "PlaytimeRewardProgress" SET "userDiscordId"=$3');
    expect(cleanup).not.toContain('SET "rewardEpoch"');
    expect(cleanup).not.toContain('SET "bucketsCredited"');
  });
});
