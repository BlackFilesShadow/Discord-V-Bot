const fs = require('node:fs');

const oldName = 'EconomyTransaction_guildId_nitradoConnId_userDiscordId_createdAt_idx';
const newName = 'EconomyTx_guild_conn_user_created_idx';

for (const path of [
  'prisma/schema.prisma',
  'prisma/migrations/20260814134500_phase4_economy_server_scope/migration.sql',
]) {
  let content = fs.readFileSync(path, 'utf8');
  const matches = content.split(oldName).length - 1;
  if (matches !== 1) {
    throw new Error(`${path}: expected ${oldName} exactly once, found ${matches}`);
  }
  content = content.replace(oldName, newName);
  fs.writeFileSync(path, content);
}

console.log(`Renamed Phase 4 index to ${newName} in schema + migration.`);
