import fs from 'node:fs';
import path from 'node:path';

const service = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'modules', 'economy', 'virtualAccounts.ts'), 'utf8');

it('beansprucht den Idempotency-Key vor der eigentlichen Saldenmutation', () => {
  const start = service.indexOf('export async function transferUserToVirtualAccount');
  const end = service.indexOf('export async function transferVirtualAccountToUser');
  const transfer = service.slice(start, end);
  expect(transfer.indexOf('INSERT INTO "EconomyVirtualAccountEntry"')).toBeGreaterThan(-1);
  expect(transfer.indexOf('INSERT INTO "EconomyVirtualAccountEntry"')).toBeLessThan(transfer.indexOf('UPDATE "EconomyAccount"'));
});
