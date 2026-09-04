import fs from 'node:fs';
import path from 'node:path';

const deletion = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'modules', 'economy', 'virtualAccountDeletion.ts'), 'utf8');
const panel = fs.readFileSync(path.join(__dirname, '..', '..', 'dashboard-ui', 'src', 'components', 'economy', 'VirtualAccountsPanel.tsx'), 'utf8');

it('virtuelle Konten verwenden nur den abgesicherten terminalen Loeschpfad', () => {
  expect(deletion).toContain("if (account.kind !== 'CUSTOM')");
  expect(deletion).toContain("finance.accountPurpose === 'BANK_TREASURY'");
  expect(deletion).toContain('EconomyVirtualAccountHistoryIdentity');
  expect(deletion).toContain('DELETE FROM \"EconomyVirtualAccount\"');
  expect(panel).not.toMatch(/api\.del\s*\(/);
});
