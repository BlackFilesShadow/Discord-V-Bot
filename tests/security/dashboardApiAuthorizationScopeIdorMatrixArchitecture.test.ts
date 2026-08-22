import fs from 'node:fs';
import { normalizeSourceNewlines } from '../helpers/sourceText';
import path from 'node:path';

const read = (relative: string) => normalizeSourceNewlines(fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8'));

const matrix = JSON.parse(read('docs/dashboard-api-authorization-scope-idor-matrix.json')) as {
  stage: number;
  attackCases: Array<{ id: string; attack: string; expected: string; evidence: string; status: string }>;
  roleMatrix: Array<{ role: string; access: string; status: string }>;
};

const authMw = read('src/dashboard/middleware/auth.ts');
const tickets = read('src/dashboard/routes/v2/tickets.ts');
const whitelist = read('src/dashboard/routes/v2/whitelist.ts');
const audit = read('src/dashboard/routes/v2/audit.ts');
const economyGuard = read('src/dashboard/middleware/economyScopeGuard.ts');
const v2 = read('src/dashboard/routes/v2.ts');
const crossGuild = read('tests/security/crossGuild.test.ts');
const scopeDb = read('tests/security/scopeMatrixArchitecture.test.ts');
const viewScope = read('tests/security/dashboardViewScope.test.ts');
const eslintRule = read('eslint-rules/no-unscoped-prisma-query.js');
const runtimeIdor = read('tests/dashboard/requireGuildPermissionIdorGate.test.ts');
const sessionGate = read('tests/dashboard/requireAuthSessionGate.test.ts');

describe('Stage 37 API authorization / scope / IDOR matrix', () => {
  it('documents attack and role cases', () => {
    expect(matrix.stage).toBe(37);
    expect(matrix.attackCases.length).toBeGreaterThanOrEqual(8);
    expect(matrix.roleMatrix.length).toBeGreaterThanOrEqual(5);
    for (const row of matrix.attackCases) {
      expect(row.id.trim()).not.toBe('');
      expect(row.attack.trim()).not.toBe('');
      expect(row.expected.trim()).not.toBe('');
      expect(row.evidence.trim()).not.toBe('');
    }
  });

  it('enforces membership-bound guild permissions and missing guildId fail-closed', () => {
    expect(authMw).toContain('export function requireGuildPermission');
    expect(authMw).toContain('GUILD_MEMBERSHIP_REQUIRED');
    expect(authMw).toContain('resolveDelegatedPermissionContext');
    expect(authMw).toContain("res.status(400).json({ error: 'guildId fehlt/ungueltig.' })");
    expect(authMw).toContain('BOT_NOT_PRESENT');
    expect(authMw).toContain('GUILD_PERM_DENIED');
  });

  it('binds guildId on representative list/mutation paths and slot economy guard', () => {
    expect(tickets).toContain('where: { guildId: scope.guildId }');
    expect(whitelist).toContain('guildId: scope.guildId');
    expect(whitelist).toContain('nitradoConnId: connId');
    expect(audit).toContain('guildId: scope.guildId');
    expect(economyGuard).toContain('requireSafeDashboardEconomyScope');
    expect(v2).toContain('requireSafeDashboardEconomyScope');
    expect(v2).toContain("requireGuildAnyPermission('economy.view', 'economy.manage')");
  });

  it('keeps existing cross-guild, view-scope, DB scope, and eslint unscoped gates', () => {
    expect(crossGuild).toContain("where: { id: 'abc-123', guildId: 'GUILD_B' }");
    expect(viewScope.length).toBeGreaterThan(100);
    expect(scopeDb).toContain('all direct Guild-scoped Prisma models');
    expect(eslintRule).toContain('DERIVED_GUILD_MODELS');
  });

  it('pins Stage 36/37 runtime middleware gates (session + IDOR deny matrix)', () => {
    expect(sessionGate).toContain('rejects legacy cookie without persistent sessionToken');
    expect(sessionGate).toContain('SESSION_REVOKED');
    expect(runtimeIdor).toContain('DENY foreign guild when bot not present');
    expect(runtimeIdor).toContain('DENY non-member even if stale grant');
    expect(runtimeIdor).toContain('DENY member missing required permission scope');
    expect(runtimeIdor).toContain('does not leak prior guildScope nitradoConnId across different guild');
    expect(runtimeIdor).not.toMatch(/test\.(only|skip)|describe\.(only|skip)/);
  });
});
