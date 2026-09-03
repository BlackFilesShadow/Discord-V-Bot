import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');
const read = (relative: string) => fs.readFileSync(path.join(root, relative), 'utf8');

const terminalRoute = read('src/dashboard/routes/v2/economyVirtualAccountTerminalDeletion.ts');
const deletion = read('src/modules/economy/virtualAccountDeletion.ts');
const systemUi = read('dashboard-ui/src/components/economy/SystemAccountsOverview.tsx');

describe('Economy domain-owned account hardening', () => {
  test('CUSTOM-backed Serverbank is not treated as a generic virtual account', () => {
    expect(terminalRoute).toContain("finance.accountPurpose === 'BANK_TREASURY' ? 'SERVER_BANK' : 'VIRTUAL_ACCOUNTS'");
    expect(terminalRoute).toContain("serialized.filter(account => account.capabilities.managedBy === 'VIRTUAL_ACCOUNTS')");
    expect(terminalRoute).toContain("serialized.filter(account => account.capabilities.managedBy !== 'VIRTUAL_ACCOUNTS')");
    expect(terminalRoute).toContain("managedBy === 'SERVER_BANK'");
    expect(terminalRoute).toContain('Serverbank-Systemkonto: Verwaltung und Lifecycle erfolgen ausschließlich über die Serverbank-Funktion.');
  });

  test('all generic mutation entry points fail closed for domain-owned live accounts', () => {
    expect(terminalRoute).toContain('rejectDeletedOrDomainOwnedMutation');
    expect(terminalRoute).toContain("owner && owner !== 'VIRTUAL_ACCOUNTS'");
    expect(terminalRoute).toContain("put('/control/accounts/:accountId'");
    expect(terminalRoute).toContain("delete('/control/accounts/:accountId'");
    expect(terminalRoute).toContain("post('/control/accounts/:accountId/sync'");
    expect(terminalRoute).toContain("post('/:accountId/archive'");
    expect(terminalRoute).toContain("post('/:accountId/payout'");
  });

  test('terminal deletion service independently rejects the Serverbank', () => {
    expect(deletion).toContain("finance.accountPurpose === 'BANK_TREASURY'");
    expect(deletion).toContain('Serverbank-Konten werden ausschließlich über die Serverbank-Funktion verwaltet und können nicht generisch gelöscht werden.');
  });

  test('read-only system workspace explicitly supports the Serverbank', () => {
    expect(systemUi).toContain("kind: 'CUSTOM' | 'LOTTERY_POT' | 'MARKET_VENDOR'");
    expect(systemUi).toContain("account.capabilities.managedBy === 'SERVER_BANK'");
    expect(systemUi).toContain('Systemkonten · Lotterie, Schwarzmarkt & Serverbank');
    expect(systemUi).not.toContain('api.post(');
    expect(systemUi).not.toContain('api.put(');
    expect(systemUi).not.toContain('api.del(');
  });
});
