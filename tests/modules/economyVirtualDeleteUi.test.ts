import fs from 'node:fs';
import path from 'node:path';

test('terminal delete is exposed only for empty CUSTOM accounts and keeps two-click confirmation', () => {
  const ui = fs.readFileSync(path.resolve(__dirname, '../../dashboard-ui/src/components/economy/VirtualAccountsControlPanel.tsx'), 'utf8');
  expect(ui).toContain("const canDelete = account.kind === 'CUSTOM' && pocketsEmpty;");
  expect(ui).toContain("{account.kind === 'CUSTOM' && (");
  expect(ui).toContain("{deleteArmed ? 'Wirklich löschen?' : 'Löschen'}");
  expect(ui).toContain('disabled={!canDelete || remove.isPending || archive.isPending}');
  expect(ui).toContain('Wallet und Bank müssen vorher 0 sein; Guthaben wird niemals verworfen.');
  expect(ui).not.toContain('customDeleteSupported');
  expect(ui).not.toContain('archivedLotteryDeleteSupported');
});
