import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');
const read = (relative: string) => fs.readFileSync(path.join(root, relative), 'utf8');

const safety = read('src/dashboard/routes/v2/economyVirtualAccountTreasurySafety.ts');
const terminal = read('src/dashboard/routes/v2/economyVirtualAccountTerminalDeletion.ts');
const v2 = read('src/dashboard/routes/v2.ts');
const wrapper = read('dashboard-ui/src/components/economy/VirtualAccountsPanel.tsx');
const controlUi = read('dashboard-ui/src/components/economy/VirtualAccountsControlPanel.tsx');
const systemUi = read('dashboard-ui/src/components/economy/SystemAccountsOverview.tsx');

describe('Economy account capability workspace', () => {
  test('authoritative routers stay ahead of compatibility control routes', () => {
    expect(v2.indexOf('economyVirtualAccountTerminalDeletionRouter'))
      .toBeLessThan(v2.indexOf('economyVirtualAccountTreasurySafetyRouter'));
    expect(v2.indexOf('economyVirtualAccountTreasurySafetyRouter'))
      .toBeLessThan(v2.indexOf('economyVirtualAccountControlRouter'));
  });

  test('generic safety list contains CUSTOM accounts and system registry is separate', () => {
    expect(safety).toContain("economyVirtualAccountTreasurySafetyRouter.get('/control/accounts'");
    expect(safety).toContain("accounts.filter(account => account.kind === 'CUSTOM')");
    expect(safety).toContain("economyVirtualAccountTreasurySafetyRouter.get('/control/system-accounts'");
    expect(safety).toContain("account.kind !== 'CUSTOM' || finance.accountPurpose === 'BANK_TREASURY'");
    expect(safety).toContain('listHiddenVirtualAccountIds');
  });

  test('mounted workspace keeps the CUSTOM-backed Serverbank readable for its dedicated editor only', () => {
    const controlListStart = terminal.indexOf("economyVirtualAccountTerminalDeletionRouter.get('/control/accounts'");
    const systemListStart = terminal.indexOf("economyVirtualAccountTerminalDeletionRouter.get('/control/system-accounts'");
    const controlList = terminal.slice(controlListStart, systemListStart);
    expect(controlList).toContain("account.capabilities.managedBy === 'VIRTUAL_ACCOUNTS'");
    expect(controlList).toContain("account.capabilities.managedBy === 'SERVER_BANK'");
    expect(controlList).not.toContain("account.capabilities.managedBy === 'LOTTERY'");
    expect(controlList).not.toContain("account.capabilities.managedBy === 'BLACK_MARKET'");

    expect(controlUi).toContain("const treasury = rows.find(account => account.accountPurpose === 'BANK_TREASURY') ?? null;");
    expect(controlUi).toContain("account.accountPurpose !== 'BANK_TREASURY'");
    expect(controlUi).toContain('accounts={listRows}');
    expect(controlUi).not.toContain('<LegacyAdminPayout guildId={guildId} slot={slot} accounts={rows}');
  });

  test('server serializes action capabilities and owning domain', () => {
    expect(safety).toContain('capabilities: {');
    expect(safety).toContain('managedBy,');
    expect(safety).toContain("canConfigure: isCustom && !hidden && account.status !== 'ARCHIVED'");
    expect(safety).toContain('canDelete: isCustom && !hidden');
    expect(safety).toContain('canArchive: false');
    expect(safety).toContain("canPayout: isCustom && !hidden && account.status === 'ACTIVE'");
    expect(safety).toContain("account.kind === 'LOTTERY_POT'");
    expect(safety).toContain("account.kind === 'MARKET_VENDOR'");
  });

  test('system accounts fail closed before generic update/delete/restore/sync handlers', () => {
    const updateBlock = safety.slice(
      safety.indexOf("economyVirtualAccountTreasurySafetyRouter.put('/control/accounts/:accountId'"),
      safety.indexOf("economyVirtualAccountTreasurySafetyRouter.post('/control/bank-treasury'"),
    );
    expect(updateBlock).toContain("if (account.kind !== 'CUSTOM')");
    expect(updateBlock.indexOf("account.kind !== 'CUSTOM'")).toBeLessThan(updateBlock.indexOf('updateConfiguredVirtualAccount'));

    expect(safety).toContain("economyVirtualAccountTreasurySafetyRouter.delete('/control/accounts/:accountId', requireGuildPermission('economy.manage'), requireCustomControlAccount)");
    expect(safety).toContain("economyVirtualAccountTreasurySafetyRouter.post('/control/accounts/:accountId/restore', requireGuildPermission('economy.manage'), requireCustomControlAccount)");
    expect(safety).toContain("economyVirtualAccountTreasurySafetyRouter.post('/control/accounts/:accountId/sync', requireGuildPermission('economy.manage'), requireCustomControlAccount)");
    expect(safety).toContain('Systemkonten werden ausschließlich über ihre Fachfunktion verwaltet.');
  });

  test('virtual accounts workspace composes custom, system, lottery and market surfaces', () => {
    expect(wrapper).toContain('<VirtualAccountsControlPanel');
    expect(wrapper).toContain('openTreasuryConfiguration={openTreasuryConfiguration}');
    expect(wrapper).toContain('<SystemAccountsOverview guildId={guildId} slot={slot} onConfigureServerBank={() => setOpenTreasuryConfiguration(true)} />');
    expect(wrapper).toContain('<LotteryPanel guildId={guildId} slot={slot} />');
    expect(wrapper).toContain('<BlackMarketPanel guildId={guildId} slot={slot} />');
  });

  test('system registry is resilient, never hides incomplete responses and links to serverbank configuration', () => {
    expect(systemUi).toContain('/control/system-accounts?slot=');
    expect(systemUi).toContain('const responseAccounts = query.data?.accounts');
    expect(systemUi).toContain('const hasValidAccounts = Array.isArray(responseAccounts)');
    expect(systemUi).toContain('Array.isArray(responseAccounts) ? responseAccounts : []');
    expect(systemUi).toContain('query.data && !hasValidAccounts');
    expect(systemUi).toContain('Systemkonto-Antwort ist unvollständig.');
    expect(systemUi).toContain('hasValidAccounts && accounts.length === 0');
    expect(systemUi).toContain('accounts.map(account =>');
    expect(systemUi).toContain('account.capabilities.managedBy');
    expect(systemUi).toContain('account.capabilities.readOnlyReason');
    expect(systemUi).toContain("account.capabilities.managedBy === 'SERVER_BANK'");
    expect(systemUi).toContain('Serverbank konfigurieren');
    expect(systemUi).not.toContain('api.post(');
    expect(systemUi).not.toContain('api.put(');
    expect(systemUi).not.toContain('api.del(');
  });
});
