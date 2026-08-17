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
    expect(ruleSource).toContain("messageId: 'dynamicArg'");
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

  test('Discord player identity rows without direct guildId are explicitly classified, not silently accepted', () => {
    const userScoped = models.filter((model) => hasField(model, 'userDiscordId'));
    expect(userScoped.length).toBeGreaterThan(5);

    const withoutDirectGuild = userScoped
      .filter((model) => !hasField(model, 'guildId'))
      .map((model) => model.name)
      .sort();

    // Global DEV/control-plane records intentionally identify the operator
    // independent of one Discord Guild. FactionMember inherits its Guild from
    // the mandatory Faction relation. Any NEW exception must make this test
    // fail and be explicitly classified during an audit.
    expect(withoutDirectGuild).toEqual([
      'BotAdminSession',
      'DevSession',
      'DevUpload',
      'FactionMember',
    ]);

    const factionMember = models.find((model) => model.name === 'FactionMember');
    expect(factionMember).toBeDefined();
    expect(hasField(factionMember!, 'factionId')).toBe(true);
    expect(factionMember!.body).toMatch(/Faction\s+@relation\(fields:\s*\[factionId\]/);
  });

  test('critical live-player rows expose an explicit Guild + Gameserver tuple and an identity carrier', () => {
    const expectedCritical: Record<string, string> = {
      GameIdentityLink: 'userDiscordId',
      WhitelistEntry: 'gameId',
      WhitelistRequest: 'gameId',
      EconomyAccount: 'userDiscordId',
      PlayerSession: 'gameId',
      NitradoSnapshot: 'serviceId',
    };

    for (const [modelName, identityField] of Object.entries(expectedCritical)) {
      const model = models.find((candidate) => candidate.name === modelName);
      expect(model).toBeDefined();
      expect(hasField(model!, 'guildId')).toBe(true);
      expect(hasField(model!, 'nitradoConnId')).toBe(true);
      expect(hasField(model!, identityField)).toBe(true);
    }
  });
});
