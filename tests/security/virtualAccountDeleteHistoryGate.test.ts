import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src/modules/economy/virtualAccountDeletion.ts'), 'utf8');

describe('virtual account hard-delete history gate', () => {
  it('checks ledger and all current system references before DELETE', () => {
    const entryCheck = source.indexOf('"EconomyVirtualAccountEntry"');
    const lotteryCheck = source.indexOf('"LotteryRound"');
    const marketListingCheck = source.indexOf('"EconomyMarketListing"');
    const marketPurchaseCheck = source.indexOf('"EconomyMarketPurchase"');
    const deletion = source.indexOf('DELETE FROM "EconomyVirtualAccount"');
    for (const check of [entryCheck, lotteryCheck, marketListingCheck, marketPurchaseCheck]) {
      expect(check).toBeGreaterThanOrEqual(0);
      expect(check).toBeLessThan(deletion);
    }
  });
});
