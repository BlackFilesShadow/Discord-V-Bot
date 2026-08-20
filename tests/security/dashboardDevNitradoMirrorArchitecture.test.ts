import fs from 'node:fs';
import path from 'node:path';

function source(relativePath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
}

describe('Dashboard-2F DEV Nitrado Mirror architecture', () => {
  const v2 = source('src/dashboard/routes/v2.ts');
  const route = source('src/dashboard/routes/v2/devNitradoMirror.ts');
  const ui = source('dashboard-ui/src/pages/dev/NitradoMirror.tsx');

  it('mountet den Router hinter der globalen DEV-Identitaet', () => {
    expect(v2).toContain("v2Router.use('/dev/nitrado-mirror', requireGlobalDeveloperIdentity, devNitradoMirrorRouter);");
  });

  it('validiert aktive DevSession vor jedem Mirror-Zugriff', () => {
    const requireDevIndex = route.indexOf('devNitradoMirrorRouter.use(requireDev);');
    const firstEndpointIndex = route.indexOf("devNitradoMirrorRouter.get('/connections'");
    expect(requireDevIndex).toBeGreaterThanOrEqual(0);
    expect(firstEndpointIndex).toBeGreaterThan(requireDevIndex);
  });

  it('erzwingt Step-Up am Snapshot-Trigger und nicht nur in der UI', () => {
    expect(route).toContain("devNitradoMirrorRouter.post('/trigger', requireVerifiedDevMutationStepUp, triggerLimiter");
    expect(route).toContain("reason: stepUp.reason").not.toBeTruthy();
  });

  it('fenced restricted Sessions serverseitig und filtert Connection-Listing', () => {
    expect(route).toContain('req.devSession?.scope.guildIdRestrict');
    expect(route).toContain("code: 'DEV_SCOPE_RESTRICTED'");
    expect(route).toContain("where: restrict ? { guildId: restrict } : undefined");
    expect(route).toContain('rejectOutsideRestrictedGuild(req, res, guildId)');
  });

  it('vermeidet String-Koerzierung fuer Query-/Body-Scope-Inputs', () => {
    expect(route).not.toMatch(/String\(req\.(?:query|body|params)/);
    expect(route).toContain('parseGuildId(req.body?.guildId)');
    expect(route).toContain('parseOpaqueId(req.body?.connId)');
    expect(route).toContain('parseSearch(req.query.q)');
    expect(route).toContain('parseMirrorPath(req.query.path)');
  });

  it('preflightet Connection/Snapshot-Bindungen vor Servicezugriff', () => {
    expect(route).toContain('connectionExistsInGuild(connId, guildId)');
    expect(route).toContain('snapshotExistsInGuild(snapshotId, guildId)');
    expect(route).toContain('startSnapshot({ guildId, nitradoConnId: connId, triggeredBy: userId })');
  });

  it('nutzt den gemeinsamen Step-Up-Dialog und mobile containment im Client', () => {
    expect(ui).toContain('StepUpModal');
    expect(ui).toContain('reason: stepUp.reason');
    expect(ui).toContain('reAuth: stepUp.reAuth');
    expect(ui).toContain('aria-label="Nitrado-Connection"');
    expect(ui).toContain('min-h-11');
    expect(ui).toContain('overflow-x-auto');
    expect(ui).toContain('role="alert"');
    expect(ui).not.toContain('Strikt nur GET');
  });
});
