import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

test('virtual account removal is balance/status independent while preserving domain history', () => {
  const deletion = read('src/modules/economy/virtualAccountDeletion.ts');
  const route = read('src/dashboard/routes/v2/economyVirtualAccountControl.ts');
  const ui = read('dashboard-ui/src/components/economy/VirtualAccountsControlPanel.tsx');

  expect(deletion).toContain('status- and balance-independent');
  expect(deletion).toContain('SET "bankBalance"=0');
  expect(deletion).toContain('SET "balance"=0');
  expect(deletion).toContain('EconomyVirtualAccountControlHidden');
  expect(deletion).toContain('CONTROL_DELETE_RESET');
  expect(deletion).toContain("account.kind === 'LOTTERY_POT' || account.kind === 'MARKET_VENDOR'");
  expect(ui).toContain("{deleteArmed ? 'Wirklich löschen?' : 'Löschen'}");
  expect(route.indexOf('deleteUnusedVirtualAccount')).toBeLessThan(route.indexOf('retireVirtualAccountProjection', route.indexOf("delete('/control/accounts/:accountId'")));
});

test('virtual account live updates are serialized per account, not per channel', () => {
  const live = read('src/modules/economy/virtualAccountLiveUpdates.ts');
  const discord = read('src/modules/economy/virtualAccountDiscord.ts');
  const migration = read('prisma/migrations/20260826190000_virtual_account_wallet_bank_currency_projection/migration.sql');

  expect(live).toContain('accountSyncInFlight');
  expect(live).toContain('${String(guildId)}:${String(connId)}:${accountId}');
  expect(discord).toContain('archiveChannel.threads.create');
  expect(discord).toContain('archiveThreadId');
  expect(migration).toContain('EconomyVirtualAccountProjection_pkey');
  expect(migration).not.toContain('UNIQUE ("channelId")');
});
