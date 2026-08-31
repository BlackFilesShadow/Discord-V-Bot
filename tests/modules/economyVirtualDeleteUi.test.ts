import fs from 'node:fs';
import path from 'node:path';

test('all visible virtual accounts expose the same two-click delete control', () => {
  const ui = fs.readFileSync(path.resolve(__dirname, '../../dashboard-ui/src/components/economy/VirtualAccountsControlPanel.tsx'), 'utf8');
  expect(ui).toContain("{deleteArmed ? 'Wirklich löschen?' : 'Löschen'}");
  expect(ui).toContain('disabled={remove.isPending || archive.isPending}');
  expect(ui).not.toContain('customDeleteSupported');
  expect(ui).not.toContain('archivedLotteryDeleteSupported');
});
