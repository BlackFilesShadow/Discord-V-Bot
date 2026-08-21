import fs from 'node:fs';
import { normalizeSourceNewlines } from '../helpers/sourceText';
import path from 'node:path';

const read = (relative: string): string => normalizeSourceNewlines(fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8'));

const booking = read('src/modules/economy/rewardBooking.ts');
const ledger = read('src/modules/economy/ledger.ts');
const leaveSaga = read('src/modules/moderation/leaveCleanupSaga.ts');
const leaveEconomy = read('src/modules/moderation/leaveCleanupLinkEconomy.ts');

describe('Economy reward booking atomicity / leave-race architecture gate', () => {
  it('keeps RewardDecision claim, ledger mutation and PAID finalization in one transaction', () => {
    expect(booking).toContain('client.$transaction');
    expect(booking).toContain("status: 'PENDING'");
    expect(booking).toContain("data: { status: 'REVIEW' }");
    expect(booking).toContain('bookLedgerEntryInTx(tx');
    expect(booking).toContain("status: 'PAID'");
    expect(ledger).toContain('export async function bookLedgerEntryInTx');
  });

  it('serializes reward writes with the same leave-enqueue advisory key and blocks open cleanup', () => {
    expect(booking).toContain('leaveCleanupJobKey(scope.guildId, decision.userDiscordId)');
    expect(booking).toContain('pg_advisory_xact_lock(hashtextextended($1, 0))');
    expect(booking).toContain("status: { in: ['PENDING', 'IN_PROGRESS', 'FAILED'] }");
    expect(leaveSaga).toContain('pg_advisory_xact_lock(hashtextextended(${key}, 0))');
    expect(leaveEconomy).toContain("'LEAVE_RESET'");
    expect(leaveEconomy).toContain("'PENDING'::\"RewardDecisionStatus\"");
  });

  it('recovers only an exact legacy reward ledger commit and fails closed on mismatches', () => {
    expect(booking).toContain('economyLedgerEntry.findUnique');
    expect(booking).toContain('assertMatchingLegacyLedger');
    expect(booking).toContain("row.type === 'GRANT'");
    expect(booking).toContain('row.sourceRef === expected.sourceRef');
    expect(booking).toContain('Reward-Ledger-Recovery');
  });

  it('pins exact guild + gameserver + user + amount on the stale-snapshot CAS', () => {
    for (const field of [
      'guildId: scope.guildId',
      'nitradoConnId: scope.nitradoConnId',
      'userDiscordId: decision.userDiscordId',
      'calculated: decision.calculated',
    ]) expect(booking).toContain(field);
  });
});
