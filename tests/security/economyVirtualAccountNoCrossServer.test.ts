import fs from 'node:fs';
import path from 'node:path';

const service = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'modules', 'economy', 'virtualAccounts.ts'), 'utf8');

it('virtuelle Konten besitzen keinen ungescopten Account-Lookup', () => {
  expect(service).not.toMatch(/FROM "EconomyVirtualAccount" WHERE "id"=\$1 LIMIT 1/);
  expect(service).not.toMatch(/UPDATE "EconomyVirtualAccount" SET[\s\S]{0,240}WHERE "id"=\$1(?! AND "guildId")/);
});
