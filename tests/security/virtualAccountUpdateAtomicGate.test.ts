import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');
const route = fs.readFileSync(path.join(ROOT, 'src/dashboard/routes/v2/economyVirtualAccountControl.ts'), 'utf8');
const configuration = fs.readFileSync(path.join(ROOT, 'src/modules/economy/virtualAccountConfiguration.ts'), 'utf8');

describe('virtual account update atomicity gate', () => {
  it('routes existing-account edits through the shared transaction service', () => {
    expect(route).toContain('updateConfiguredVirtualAccount({');
    expect(configuration).toContain('export async function updateConfiguredVirtualAccount');
    expect(configuration).toContain('await prisma.$transaction(async tx =>');
    expect(configuration).toContain('FOR UPDATE');
    expect(configuration).toContain('UPDATE "EconomyVirtualAccountFinance"');
    expect(configuration).toContain('DELETE FROM "EconomyVirtualAccountManager"');
  });
});
