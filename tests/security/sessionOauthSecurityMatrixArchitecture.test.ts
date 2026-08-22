import fs from 'node:fs';
import path from 'node:path';

const r = (p: string) => fs.readFileSync(path.resolve(process.cwd(), p), 'utf8');
const m = JSON.parse(r('docs/session-oauth-security-matrix.json')) as { stage: number };
const auth = r('src/dashboard/routes/auth.ts');
const mw = r('src/dashboard/middleware/auth.ts');
const server = r('src/dashboard/server.ts');
const sessionRuntime = r('tests/dashboard/requireAuthSessionGate.test.ts');
const httpDbIntegration = r('tests/security/dashboardSecurityHttpDbIntegration.test.ts');

describe('Stage 43 session OAuth security matrix', () => {
  it('documents stage', () => {
    expect(m.stage).toBe(43);
  });

  it('covers OAuth persistence, logout revoke, and cookie flags', () => {
    expect(auth).toContain('session.save');
    expect(auth).toContain('req.session.regenerate');
    expect(auth).toContain('isActive: false');
    expect(auth).toContain('req.session.destroy');
    expect(mw).toContain('SESSION_REVOKED');
    expect(server).toContain('httpOnly: true');
    expect(server).toContain("sameSite: 'lax'");
  });

  it('pins Stage 43 session runtime revoke/expiry/fail-closed evidence', () => {
    expect(sessionRuntime).toContain('rejects revoked prisma session token');
    expect(sessionRuntime).toContain('rejects expired prisma session token');
    expect(sessionRuntime).toContain('rejects session token bound to another user');
    expect(sessionRuntime).toContain('fails closed when prisma session lookup errors');
    expect(httpDbIntegration).toContain('rotates the OAuth cookie session');
    expect(httpDbIntegration).toContain('not.toBe(preLoginCookie)');
    expect(sessionRuntime).not.toMatch(/test\.(only|skip)|describe\.(only|skip)/);
    expect(httpDbIntegration).not.toMatch(/test\.(only|skip)|describe\.(only|skip)/);
  });
});
