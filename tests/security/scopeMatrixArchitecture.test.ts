import fs from 'node:fs';
import path from 'node:path';

interface PrismaModelShape {
  name: string;
  body: string;
}

function parseModels(schema: string): PrismaModelShape[] {
  const out: PrismaModelShape[] = [];
  const re = /model\s+(\w+)\s*\{([\s\S]*?)\n\}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(schema)) !== null) out.push({ name: match[1], body: match[2] });
  return out;
}

function hasField(model: PrismaModelShape, field: string): boolean {
  return new RegExp(`\\n\\s*${field}\\s+\\S`).test(`\n${model.body}`);
}

describe('DB-1 repo-wide scope matrix', () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const schema = fs.readFileSync(path.join(repoRoot, 'prisma/schema.prisma'), 'utf8');
  const eslintConfig = fs.readFileSync(path.join(repoRoot, 'eslint.config.mjs'), 'utf8');
  const ruleSource = fs.readFileSync(path.join(repoRoot, 'eslint-rules/no-unscoped-prisma-query.js'), 'utf8');
  const models = parseModels(schema);

  test('all direct Guild-scoped Prisma models are a hard CI gate, not an advisory subset', () => {
    const guildScoped = models.filter((model) => hasField(model, 'guildId'));
    expect(guildScoped.length).toBeGreaterThan(30);

    expect(eslintConfig).toContain("'local/no-unscoped-prisma-query': ['error', { set: 'all' }]");
    expect(eslintConfig).not.toContain('no-unscoped-prisma-query-extra');
    expect(ruleSource).toContain("if (setName === 'all')");
    expect(ruleSource).toContain('DERIVED_GUILD_MODELS');
  });

  test('every direct gameserver identifier is also bound to an explicit Guild in the same row', () => {
    const gameserverScoped = models.filter((model) => hasField(model, 'nitradoConnId'));
    expect(gameserverScoped.length).toBeGreaterThan(15);

    const missingGuildScope = gameserverScoped
      .filter((model) => !hasField(model, 'guildId'))
      .map((model) => model.name)
      .sort();
    expect(missingGuildScope).toEqual([]);
  });

  test('every direct Discord player identity scope is also bound to an explicit Guild', () => {
    const userScoped = models.filter((model) => hasField(model, 'userDiscordId'));
    expect(userScoped.length).toBeGreaterThan(5);

    const missingGuildScope = userScoped
      .filter((model) => !hasField(model, 'guildId'))
      .map((model) => model.name)
      .sort();
    expect(missingGuildScope).toEqual([]);
  });

  test('critical three-dimensional rows expose Guild + Gameserver + User together', () => {
    const expectedCritical = [
      'GameIdentityLink',
      'WhitelistEntry',
      'WhitelistRequest',
      'EconomyAccount',
      'PlayerSession',
      'PlayerStat',
    ];

    for (const modelName of expectedCritical) {
      const model = models.find((candidate) => candidate.name === modelName);
      expect(model).toBeDefined();
      expect(hasField(model!, 'guildId')).toBe(true);
      expect(hasField(model!, 'nitradoConnId')).toBe(true);
      // Whitelist uses game/player naming in addition to the Discord actor/requester.
      // The remaining identity-bearing rows must carry the canonical Discord player ID.
      if (!['WhitelistEntry', 'WhitelistRequest'].includes(modelName)) {
        expect(hasField(model!, 'userDiscordId')).toBe(true);
      }
    }
  });
});
