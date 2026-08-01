/**
 * F-005: Die no-unscoped-prisma-query-Regel leitet tenant-scoped Models aus
 * dem Schema ab und erzwingt guildId im where. Strict-Set = harter Fehler,
 * Extras-Set (aus Schema abgeleitet) = Advisory.
 */
import { RuleTester } from 'eslint';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const rule = require('../../eslint-rules/no-unscoped-prisma-query.js');

const tester = new RuleTester({ languageOptions: { ecmaVersion: 2022, sourceType: 'module' } });

tester.run('no-unscoped-prisma-query (F-005)', rule, {
  valid: [
    // strict Model mit guildId -> ok
    { code: 'prisma.economyAccount.findMany({ where: { guildId: g } });', options: [{ set: 'strict' }] },
    // Compound-Key mit guildId_* -> ok
    { code: 'prisma.economyAccount.findUnique({ where: { guildId_userDiscordId: { guildId: g, userDiscordId: u } } });', options: [{ set: 'strict' }] },
    // create hat kein where -> ok
    { code: 'prisma.economyAccount.create({ data: { guildId: g } });', options: [{ set: 'strict' }] },
    // ticket ist kein strict Model -> unter strict nicht geprueft
    { code: 'prisma.ticket.findMany({ where: {} });', options: [{ set: 'strict' }] },
  ],
  invalid: [
    // strict Model ohne guildId -> Fehler
    {
      code: 'prisma.economyAccount.findMany({ where: {} });',
      options: [{ set: 'strict' }],
      errors: [{ messageId: 'missingGuildId' }],
    },
    // ticket (aus Schema abgeleitet) -> unter extras geflaggt
    {
      code: 'prisma.ticket.findMany({ where: {} });',
      options: [{ set: 'extras' }],
      errors: [{ messageId: 'missingGuildId' }],
    },
  ],
});
