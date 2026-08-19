import fs from 'node:fs';
import path from 'node:path';

describe('Dashboard-1N factions API hardening architecture gate', () => {
  const root = path.resolve(__dirname, '../..');
  const v2 = fs.readFileSync(path.join(root, 'src/dashboard/routes/v2.ts'), 'utf8');
  const hardening = fs.readFileSync(path.join(root, 'src/dashboard/middleware/factionApiHardening.ts'), 'utf8');
  const factions = fs.readFileSync(path.join(root, 'src/dashboard/routes/v2/factions.ts'), 'utf8');

  it('mountet autorisierten Guild-Scope, Preflight und Race-Serializer vor dem Factions-Router', () => {
    expect(v2).toContain("const requireFactionsDashboardAccess = requireGuildAnyPermission('factions.view', 'factions.manage');");
    expect(v2).toContain("v2Router.use('/guilds/:guildId/factions', requireFactionsDashboardAccess, factionApiPreflight, factionMutationSerialization, factionsRouter);");
    expect(v2).toContain("v2Router.use('/guilds/:guildId/factions', factionApiErrorBoundary);");
  });

  it('haelt Preflight read-only und erzwingt Config-Upsert ausschließlich im PUT-Pfad', () => {
    expect(hardening).not.toContain('factionSystemConfig.upsert');
    expect(factions).toContain("factionsRouter.get('/system-config'");
    expect(factions).toContain('const cfg = await prisma.factionSystemConfig.findUnique');
    expect(factions).toContain("updatedAt: cfg ? cfg.updatedAt.toISOString() : null");
    expect(factions).toContain("factionsRouter.put('/system-config'");
    expect(factions).toContain('const updated = await prisma.factionSystemConfig.upsert');
  });

  it('erzwingt cross-process try-lock und stabile Prisma-Race-Grenzen', () => {
    expect(hardening).toContain('pg_try_advisory_xact_lock');
    expect(hardening).toContain("code === 'P2025'");
    expect(hardening).toContain("code === 'P2003'");
  });

  it('haelt Multipart-Uploads bewusst ausserhalb der lang laufenden Transaction-Lock-Grenze', () => {
    expect(hardening).toMatch(/routePath === '\/upload'/);
    expect(hardening).toMatch(/\/upload\$\/\.test\(routePath\)/);
  });
});
