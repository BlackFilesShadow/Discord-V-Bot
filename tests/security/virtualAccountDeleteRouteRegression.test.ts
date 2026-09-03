import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('Virtual account delete route regression', () => {
  const route = read('src/dashboard/routes/v2/economyVirtualAccountControl.ts');
  const service = read('src/modules/economy/virtualAccountDeletion.ts');
  const ui = read('dashboard-ui/src/components/economy/VirtualAccountsControlPanel.tsx');

  it('keeps delete manage-only and slot-scoped through the existing economy scope middleware', () => {
    expect(route).toContain("delete('/control/accounts/:accountId', requireGuildPermission('economy.manage')");
    expect(route).toContain('const { scope, connId } = scoped(req);');
    expect(route).toContain('guildId: scope.guildId');
    expect(route).toContain('nitradoConnId: connId');
  });

  it('uses the strict deletion service and never reports false success', () => {
    expect(route).toContain('await deleteUnusedVirtualAccount({');
    expect(route).toContain('res.json({ ok: true, deleted })');
    expect(route).toContain("res.status(400).json({ error: (error as Error).message })");
    expect(service).toContain('return await prisma.$transaction(async tx =>');
  });

  it('never burns funds and hard-deletes only fresh zero-balance CUSTOM rows', () => {
    expect(service).toContain('FOR UPDATE');
    expect(service).toContain('account.balance !== 0n || finance.bankBalance !== 0n');
    expect(service).toContain('Konto kann mit Restguthaben nicht gelöscht werden. Wallet und Bank müssen zuerst 0 sein.');
    expect(service).not.toContain('CONTROL_DELETE_RESET');
    expect(service).not.toContain('SET "bankBalance"=0');
    expect(service).not.toContain('SET "balance"=0');
    expect(service).toContain('const mustPreserveRow = Boolean(entries[0]?.exists) || Boolean(protectedRefs[0]?.protected);');
    expect(service).toContain('return retainZeroBalanceCustomHistory');
    expect(service).toContain('DELETE FROM "EconomyVirtualAccount"');
    expect(service).toContain(String.raw`AND "kind"=\'CUSTOM\'::"EconomyVirtualAccountKind" AND "balance"=0`);
  });

  it('keeps immutable history and domain-owned system accounts fail closed', () => {
    expect(service).toContain("if (account.kind !== 'CUSTOM')");
    expect(service).toContain('Systemkonten werden ausschließlich über ihre Fachfunktion verwaltet.');
    expect(service).toContain('EconomyVirtualAccountEntry');
    expect(service).toContain('LotteryRound');
    expect(service).toContain('EconomyMarketListing');
    expect(service).toContain('EconomyMarketPurchase');
    expect(service).toContain("candidate.code === '23503'");
  });

  it('requires an explicit second UI confirmation click', () => {
    expect(ui).toContain('deleteConfirmId');
    expect(ui).toContain("'Wirklich löschen?' : 'Löschen'");
    expect(ui).toContain('if (!deleteArmed)');
    expect(ui).toContain('remove.mutate(account.id)');
  });
});
