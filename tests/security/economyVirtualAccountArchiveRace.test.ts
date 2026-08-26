import fs from 'node:fs';
import path from 'node:path';

const service = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'modules', 'economy', 'virtualAccounts.ts'), 'utf8');

it('Archivierung lockt Konto und Finance bevor Wallet und Bank gemeinsam geprueft werden', () => {
  const archiveStart = service.indexOf('export async function archiveVirtualAccount');
  const archiveEnd = service.indexOf('export async function listVirtualAccountEntries');
  const archive = service.slice(archiveStart, archiveEnd);

  const accountLock = archive.indexOf('findVirtualAccountById(raw, args.guildId, args.nitradoConnId, args.accountId, true)');
  const financeLock = archive.indexOf('FROM "EconomyVirtualAccountFinance"');
  const financeForUpdate = archive.indexOf('LIMIT 1 FOR UPDATE', financeLock);
  const balanceCheck = archive.indexOf('current.balance !== 0n || finance.bankBalance !== 0n');
  const archiveUpdate = archive.indexOf('UPDATE "EconomyVirtualAccount" SET', balanceCheck);

  expect(accountLock).toBeGreaterThan(-1);
  expect(financeLock).toBeGreaterThan(accountLock);
  expect(financeForUpdate).toBeGreaterThan(financeLock);
  expect(balanceCheck).toBeGreaterThan(financeForUpdate);
  expect(archiveUpdate).toBeGreaterThan(balanceCheck);
  expect(archive).toContain('WHERE "accountId"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 LIMIT 1 FOR UPDATE');
  expect(archive).toContain("if (!finance) throw new Error('Konto-Finanzprofil fehlt; Archivierung wird sicherheitshalber abgebrochen.');");
  expect(archive).toContain('Wallet und Bank muessen 0 sein.');
  expect(archive).toContain('AND "balance"=0 RETURNING');
});
