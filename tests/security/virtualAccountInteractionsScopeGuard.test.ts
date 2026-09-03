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
