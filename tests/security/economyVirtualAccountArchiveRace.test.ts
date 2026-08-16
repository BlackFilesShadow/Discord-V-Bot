import fs from 'node:fs';
import path from 'node:path';

const service = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'modules', 'economy', 'virtualAccounts.ts'), 'utf8');

it('Archivierung liest das virtuelle Konto unter Row-Lock bevor der Saldo geprueft wird', () => {
  const archiveStart = service.indexOf('export async function archiveVirtualAccount');
  const archiveEnd = service.indexOf('export async function listVirtualAccountEntries');
  const archive = service.slice(archiveStart, archiveEnd);
  expect(archive).toContain('findVirtualAccountById(raw, args.guildId, args.nitradoConnId, args.accountId, true)');
  expect(archive.indexOf('findVirtualAccountById')).toBeLessThan(archive.indexOf('current.balance !== 0n'));
});
