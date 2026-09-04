import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');
const read = (relative: string) => fs.readFileSync(path.join(root, relative), 'utf8');

const route = read('src/dashboard/routes/v2/economyVirtualAccounts.ts');
const command = read('src/commands/dashboard/virtualAccounts.ts');
const systemTransfers = read('src/modules/economy/systemVirtualTransfers.ts');
const lottery = read('src/modules/economy/lottery.ts');
const market = read('src/modules/economy/blackMarket.ts');

describe('Economy system-account manipulation boundary', () => {
  test('generic dashboard payout rejects non-CUSTOM accounts before money mutation', () => {
    expect(route).toContain("if (account.kind !== 'CUSTOM')");
    expect(route).toContain('Systemkonten werden ausschliesslich durch ihre Fachfunktion verwaltet.');

    const payoutRoute = route.slice(route.indexOf("post('/:accountId/payout'"));
    expect(payoutRoute).toContain('await requireCustomAccount(scope.guildId, connId, String(req.params.accountId));');
    expect(payoutRoute.indexOf('requireCustomAccount')).toBeLessThan(payoutRoute.indexOf('transferVirtualAccountToUser'));
  });

  test('generic Discord virtual-account pay cannot target lottery or market system accounts', () => {
    const payBlock = command.slice(command.indexOf("if (sub === 'pay')"));
    expect(payBlock).toContain("if (account.kind !== 'CUSTOM')");
    expect(payBlock).toContain('Systemkonto geschützt');
    expect(payBlock).toContain('safeDepositUserIntoVirtualAccount');
    expect(payBlock.indexOf("account.kind !== 'CUSTOM'")).toBeLessThan(payBlock.indexOf('safeDepositUserIntoVirtualAccount'));
  });

  test('system money paths remain kind-pinned under the same transaction and locked account', () => {
    expect(systemTransfers).toContain('expectedKind: VirtualAccountKind;');
    expect(systemTransfers).toContain('FOR UPDATE');
    expect(systemTransfers).toContain("if (account.kind !== args.expectedKind) throw new Error('Systemkonto hat den falschen Kontotyp.')");
    expect(systemTransfers).toContain('return prisma.$transaction(async tx =>');
  });

  test('lottery and market callers bind every system transfer to their dedicated account kind', () => {
    expect(lottery).toContain("expectedKind: 'LOTTERY_POT'");
    expect(market).toContain("expectedKind: 'MARKET_VENDOR'");
    expect(lottery).toContain('acceptUserTransfers: false');
    expect(market).toContain('acceptUserTransfers: false');
  });
});
