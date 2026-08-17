import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.resolve(process.cwd(), 'src/modules/moderation/leaveCleanupLinkEconomy.ts'), 'utf8');

describe('Leave-1C final internal safety markers', () => {
  it('keeps open rewards from paying after reset begins', () => {
    expect(source).toContain("'SKIPPED'::\"RewardDecisionStatus\"");
    expect(source).toContain("\"reasonCode\"='LEAVE_RESET'");
  });

  it('deletes mutable player state only after history pseudonymization in the transaction body', () => {
    const history = source.indexOf('pseudonymizeHistory(trx');
    const accountDelete = source.indexOf('DELETE FROM "EconomyAccount"');
    const stateDelete = source.indexOf('DELETE FROM "EconomyLinkRewardState"');
    const linkDelete = source.indexOf('DELETE FROM "GameIdentityLink"');
    expect(history).toBeGreaterThanOrEqual(0);
    expect(accountDelete).toBeGreaterThan(history);
    expect(stateDelete).toBeGreaterThan(accountDelete);
    expect(linkDelete).toBeGreaterThan(stateDelete);
  });
});
