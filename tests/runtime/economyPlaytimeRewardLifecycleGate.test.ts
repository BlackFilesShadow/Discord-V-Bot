import fs from 'node:fs';
import { normalizeSourceNewlines } from '../helpers/sourceText';
import path from 'node:path';

const read = (relative: string): string => normalizeSourceNewlines(fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8'));

const booking = read('src/modules/economy/playtimeBooking.ts');
const postProcess = read('src/modules/nitrado/adm/admPostProcessCron.ts');
const leaveSaga = read('src/modules/moderation/leaveCleanupSaga.ts');

describe('Economy playtime reward lifecycle architecture gate', () => {
  it('serializes session progress and ledger writes in one reward transaction', () => {
    expect(booking).toContain('return client.$transaction');
    expect(booking).toContain('bookLedgerEntryInTx(tx');
    expect(booking).toContain('persistProgress(tx');
    expect(booking).toContain('playtimeRewardProgress.findUnique');
  });

  it('uses the same leave advisory key and blocks every open cleanup state', () => {
    expect(booking).toContain('leaveCleanupJobKey(scope.guildId, link.userDiscordId)');
    expect(booking).toContain('pg_advisory_xact_lock(hashtextextended($1, 0))');
    expect(booking).toContain("status: { in: ['PENDING', 'IN_PROGRESS', 'FAILED'] }");
    expect(leaveSaga).toContain('pg_advisory_xact_lock(hashtextextended(${key}, 0))');
  });

  it('revalidates exact current identity + reward epoch under a row lock', () => {
    expect(booking).toContain('FOR UPDATE');
    expect(booking).toContain('current.identityHash !== link.identityHash');
    expect(booking).toContain('current.rewardEligibleFrom.getTime() !== link.rewardEligibleFrom.getTime()');
    expect(booking).toContain('current.unlinkedAt !== null');
    expect(postProcess).toContain('identityHash: identityHash(gameId, config.security.encryptionKey)');
  });

  it('accepts only structurally matching historical bucket commits during recovery', () => {
    expect(booking).toContain('assertMatchingHistoricalBucket');
    expect(booking).toContain("row.type === 'PLAYTIME_REWARD'");
    expect(booking).toContain('row.buckets === 1');
    expect(booking).toContain('row.sourceRef === expected.sourceRef');
    expect(booking).toContain('Playtime-Ledger-Recovery');
  });
});
