import fs from 'node:fs';
import path from 'node:path';

const route = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'dashboard', 'routes', 'v2', 'economyVirtualAccounts.ts'), 'utf8');
const panel = fs.readFileSync(path.join(__dirname, '..', '..', 'dashboard-ui', 'src', 'components', 'economy', 'VirtualAccountsPanel.tsx'), 'utf8');

it('virtuelle Konten werden nur archiviert und nie physisch geloescht', () => {
  expect(route).not.toMatch(/\.delete\s*\(/);
  expect(panel).not.toMatch(/api\.del\s*\(/);
  expect(route).toContain("post('/:accountId/archive'");
});
