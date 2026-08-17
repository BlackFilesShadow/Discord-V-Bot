/**
 * DB-1: Die no-unscoped-prisma-query-Regel leitet tenant-scoped Models aus
 * dem Schema ab. `set: all` ist der Produktionsvertrag: jedes Model mit
 * direktem guildId muss bei Reads/Updates/Deletes einen expliziten Guild-Scope
 * im where tragen. Nicht statisch pruefbare dynamische Query-Argumente sind
 * ebenfalls fail-closed.
 */
import { RuleTester } from 'eslint';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const rule = require('../../eslint-rules/no-unscoped-prisma-query.js');

const tester = new RuleTester({ languageOptions: { ecmaVersion: 2022, sourceType: 'module' } });

tester.run('no-unscoped-prisma-query (DB-1)', rule, {
  valid: [
    { code: 'prisma.economyAccount.findMany({ where: { guildId: g } });', options: [{ set: 'all' }] },
    { code: 'prisma.economyAccount.findUnique({ where: { guildId_userDiscordId: { guildId: g, userDiscordId: u } } });', options: [{ set: 'all' }] },
    { code: 'prisma.ticket.findMany({ where: { guildId: g } });', options: [{ set: 'all' }] },
    { code: 'prisma.levelData.updateMany({ where: { AND: [{ guildId: g }, { level: 5 }] }, data: { level: 6 } });', options: [{ set: 'all' }] },
    // create wird vom Rule-Contract separat ueber Service-/DB-Invarianten geprueft;
    // diese Regel schuetzt query-/mutation where-Scope.
    { code: 'prisma.economyAccount.create({ data: { guildId: g } });', options: [{ set: 'all' }] },
  ],
  invalid: [
    {
      code: 'prisma.economyAccount.findMany({ where: {} });',
      options: [{ set: 'all' }],
      errors: [{ messageId: 'missingGuildId' }],
    },
    {
      code: 'prisma.ticket.findMany({ where: {} });',
      options: [{ set: 'all' }],
      errors: [{ messageId: 'missingGuildId' }],
    },
    {
      code: 'prisma.levelData.deleteMany({ where: { userId: u } });',
      options: [{ set: 'all' }],
      errors: [{ messageId: 'missingGuildId' }],
    },
    {
      code: 'prisma.economyAccount.findMany(buildTenantArgs(g));',
      options: [{ set: 'all' }],
      errors: [{ messageId: 'dynamicArg' }],
    },
  ],
});
