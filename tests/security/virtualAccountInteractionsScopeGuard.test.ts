import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

test('Discord virtual-account interaction lookup is guild-scoped before account access', () => {
  const source = read('src/modules/economy/virtualAccountInteractions.ts');

  expect(source).toContain('resolveAccountScope(guildId: string, accountId: string)');
  expect(source).toContain('WHERE "id"=$1 AND "guildId"=$2 LIMIT 1');
  expect(source).toContain('resolveAccountScope(guildId, accountId)');
  expect(source).not.toContain('resolveAccountScope(accountId)');
  expect(source).toContain('await interaction.deferUpdate()');
  expect(source).toContain('await interaction.editReply({ embeds: [embed], components });');
});

test('generic manager workflows expose and mutate active accounts only', () => {
  const finance = read('src/modules/economy/virtualAccountFinance.ts');
  const safety = read('src/modules/economy/virtualAccountMoneySafety.ts');

  expect(finance).toContain("if (account && account.status === 'ACTIVE') accounts.push(account);");
  expect(safety).toContain("if (!account || account.status !== 'ACTIVE') throw new Error('Virtuelles Konto ist nicht aktiv.')");
  expect(safety).toContain("if (account.status !== 'ACTIVE') throw new Error('Virtuelles Konto ist nicht aktiv.')");
});
