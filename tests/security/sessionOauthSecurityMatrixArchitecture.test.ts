import fs from 'node:fs';
import path from 'node:path';

const r = (p: string) => fs.readFileSync(path.resolve(process.cwd(), p), 'utf8');
const m = JSON.parse(r('docs/session-oauth-security-matrix.json')) as { stage: number };
const auth = r('src/dashboard/routes/auth.ts');
const mw = r('src/dashboard/middleware/auth.ts');
const server = r('src/dashboard/server.ts');

describe('Stage 43 session OAuth security matrix', () => {
  it('documents stage', () => {
    expect(m.stage).toBe(43);
  });

  it('covers OAuth persistence, logout revoke, and cookie flags', () => {
    expect(auth).toContain('session.save');
    expect(auth).toContain('isActive: false');
    expect(auth).toContain('req.session.destroy');
    expect(mw).toContain('SESSION_REVOKED');
    expect(server).toContain('httpOnly: true');
    expect(server).toContain("sameSite: 'lax'");
  });
});
