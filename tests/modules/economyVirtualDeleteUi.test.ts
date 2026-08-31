import fs from 'node:fs';
import path from 'node:path';

test('active custom virtual accounts expose the delete control', () => {
  const ui = fs.readFileSync(path.resolve(__dirname, '../../dashboard-ui/src/components/economy/VirtualAccountsControlPanel.tsx'), 'utf8');
  expect(ui).toContain("const customDeleteSupported = account.kind === 'CUSTOM' && account.accountPurpose === 'GENERAL'");
  expect(ui).toContain("{deleteArmed ? 'Wirklich löschen?' : 'Löschen'}");
});
