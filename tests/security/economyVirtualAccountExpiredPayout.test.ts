import fs from 'node:fs';
import path from 'node:path';

const service = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'modules', 'economy', 'virtualAccounts.ts'), 'utf8');

it('abgelaufene Konten bleiben fuer Refunds leerbar, archivierte Konten nicht', () => {
  const start = service.indexOf('export async function transferVirtualAccountToUser');
  const payout = service.slice(start);
  expect(payout).toContain("if (account.status === 'ARCHIVED') throw new Error('Archiviertes Konto kann nicht mehr buchen.')");
  expect(payout).not.toContain("if (account.status !== 'ACTIVE')");
});
