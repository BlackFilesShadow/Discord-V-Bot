import fs from 'node:fs';
import path from 'node:path';

const service = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'modules', 'economy', 'virtualAccounts.ts'), 'utf8');

it('jede virtuelle Geldbewegung bindet Guild und Gameserver in Account-Updates', () => {
  expect(service).toContain('WHERE "guildId"=$1 AND "nitradoConnId"=$2 AND "userDiscordId"=$3');
  expect(service).toContain('WHERE "id"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3');
});
