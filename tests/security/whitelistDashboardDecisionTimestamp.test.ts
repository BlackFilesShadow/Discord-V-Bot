import fs from 'node:fs';
import path from 'node:path';

describe('whitelist dashboard decision timestamp contract', () => {
  const routePath = path.resolve(process.cwd(), 'src/dashboard/routes/v2/whitelist.ts');
  const source = fs.readFileSync(routePath, 'utf8');

  it('reuses the persisted decision timestamp for the shared archive path', () => {
    const decisionRouteStart = source.indexOf("whitelistRouter.post('/requests/:id/decision'");
    const syncRouteStart = source.indexOf("whitelistRouter.post('/sync'", decisionRouteStart);

    expect(decisionRouteStart).toBeGreaterThanOrEqual(0);
    expect(syncRouteStart).toBeGreaterThan(decisionRouteStart);

    const decisionRoute = source.slice(decisionRouteStart, syncRouteStart);

    expect(decisionRoute).toContain('const decidedAt = new Date();');
    expect(decisionRoute).toMatch(/data:\s*\{[\s\S]*?decidedAt,[\s\S]*?decidedByDiscordId:/);
    expect(decisionRoute).toMatch(/postDecisionLog\(\{[\s\S]*?decidedByDiscordId:[\s\S]*?decidedAt,[\s\S]*?\}\)/);
  });
});
