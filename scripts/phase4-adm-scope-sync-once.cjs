const fs = require('node:fs');

const path = 'src/modules/nitrado/admSyncCron.ts';
let content = fs.readFileSync(path, 'utf8');

const replacements = [
  [
    `const cfg = await prisma.economyConfig.findUnique({ where: { guildId: conn.guildId } });`,
    `const cfg = await prisma.economyConfig.findUnique({\n    where: { guildServer: { guildId: conn.guildId, nitradoConnId: conn.id } },\n  });`,
  ],
  [
    `where: { guildId_userDiscordId: { guildId: conn.guildId, userDiscordId } },\n              create: {\n                guildId: conn.guildId,\n                userDiscordId,`,
    `where: { guildServerUser: { guildId: conn.guildId, nitradoConnId: conn.id, userDiscordId } },\n              create: {\n                guildId: conn.guildId,\n                nitradoConnId: conn.id,\n                userDiscordId,`,
  ],
  [
    `data: {\n                guildId: conn.guildId,\n                userDiscordId,\n                delta: reward,\n                type: 'PLAYTIME_REWARD',`,
    `data: {\n                guildId: conn.guildId,\n                nitradoConnId: conn.id,\n                userDiscordId,\n                delta: reward,\n                type: 'PLAYTIME_REWARD',`,
  ],
];

for (const [before, after] of replacements) {
  const matches = content.split(before).length - 1;
  if (matches !== 1) {
    throw new Error(`Expected target exactly once, found ${matches}: ${before.slice(0, 100)}`);
  }
  content = content.replace(before, after);
}

fs.writeFileSync(path, content);
console.log(`Applied ${replacements.length} Phase 4 ADM scope replacements.`);
