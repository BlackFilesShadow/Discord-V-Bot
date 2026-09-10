import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (relative: string): string => fs.readFileSync(path.resolve(root, relative), 'utf8');

describe('repo deep-audit dashboard guard architecture', () => {
  const server = read('src/dashboard/server.ts');
  const v2 = read('src/dashboard/routes/v2.ts');
  const legacyApi = read('src/dashboard/routes/api.ts');
  const webhook = read('src/dashboard/routes/webhooks.ts');

  it('keeps API v2 independent from the legacy /api auth prefix while rate-limiting it exactly once', () => {
    const healthMount = "app.use('/api/health', apiLimiter, discordHealthRouter);";
    const v2Mount = "app.use('/api/v2', apiLimiter, v2Router);";
    const legacyMount = "app.use('/api', apiLimiter, apiRouter);";

    expect(server).toContain(healthMount);
    expect(server).toContain(v2Mount);
    expect(server).toContain(legacyMount);
    expect(server.indexOf(healthMount)).toBeLessThan(server.indexOf(v2Mount));
    expect(server.indexOf(v2Mount)).toBeLessThan(server.indexOf(legacyMount));
    expect(v2).toContain('v2Router.use(requireAuth);');
    expect(legacyApi).toContain('apiRouter.use(requireAuth);');
  });

  it('binds the production /test surface to the canonical authenticated session gate before its existing router logic', () => {
    expect(server).toContain("app.use('/test', apiLimiter, requireAuth, testRouter);");
  });

  it('binds /auth/2fa to a persistent application session without requiring the second factor first', () => {
    expect(server).toContain("app.use('/auth/2fa', loginLimiter, requireActivePersistentSession);");
    const activeGate = read('src/dashboard/middleware/activePersistentSession.ts');
    expect(activeGate).toContain('prisma.session.findUnique');
    expect(activeGate).toContain("code: 'SESSION_REVOKED'");
    expect(activeGate).not.toMatch(/if\s*\(\s*s\.requires2FA/);
  });

  it('lets the webhook own its raw stream and declared 512 KiB parser limit', () => {
    expect(server).toContain("req.path === '/webhooks' || req.path.startsWith('/webhooks/')");
    expect(server).toContain('jsonBodyParser(req, res, next);');
    expect(webhook).toContain("raw({ type: 'application/json', limit: '512kb' })");
  });
});