import fs from 'node:fs';
import path from 'node:path';

test('terminal delete is exposed for active CUSTOM accounts and keeps two-click confirmation', () => {
  const ui = fs.readFileSync(path.resolve(__dirname, '../../dashboard-ui/src/components/economy/VirtualAccountsControlPanel.tsx'), 'utf8');
  expect(ui).toContain("const canDelete = account.kind === 'CUSTOM' && account.status !== 'ARCHIVED';");
  expect(ui).toContain("{account.kind === 'CUSTOM' && (");
  expect(ui).toContain("{deleteArmed ? 'Wirklich löschen?' : 'Löschen'}");
  expect(ui).toContain('disabled={!canDelete || remove.isPending}');
  expect(ui).toContain('Sein Wallet- und Bankguthaben werden mit diesem Konto gelöscht.');
  expect(ui).not.toContain('Archivieren');
  expect(ui).not.toContain('customDeleteSupported');
  expect(ui).not.toContain('archivedLotteryDeleteSupported');
});
