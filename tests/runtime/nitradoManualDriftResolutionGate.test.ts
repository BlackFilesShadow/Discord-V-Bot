import fs from 'node:fs';
import path from 'node:path';
import { normalizeSourceNewlines } from '../helpers/sourceText';

const read = (relative: string): string => normalizeSourceNewlines(
  fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8'),
);

describe('manual Nitrado drift resolution gate', () => {
  it('never turns a previously SYNCED whitelist removal into an automatic re-add', () => {
    const source = read('src/modules/whitelist/whitelistSyncCron.ts');
    const intentional = source.indexOf("entry.syncState === 'LOCAL_ONLY'");
    const manual = source.indexOf("entry.syncState === 'SYNCED'");
    const enqueueLoop = source.indexOf('for (const gameId of intentionalAdds)');

    expect(intentional).toBeGreaterThanOrEqual(0);
    expect(manual).toBeGreaterThanOrEqual(0);
    expect(source).toContain('manualRemoteMissingObserved');
    expect(enqueueLoop).toBeGreaterThan(manual);
    expect(source).not.toContain('for (const gameId of diff.toAdd)');
  });

  it('pauses a previously confirmed remote ban instead of clearing provenance and repairing it', () => {
    const source = read('src/modules/bans/banReconciliation.ts');
    const active = source.indexOf('if (locallyActive)');
    const confirmedDrift = source.indexOf('if (ban.appliedRemotely)', active);
    const pause = source.indexOf('manualRemoteMissing++;', confirmedDrift);
    const exit = source.indexOf('continue;', pause);
    const repair = source.indexOf('enqueueServerBanAdd(', exit);

    expect(confirmedDrift).toBeGreaterThan(active);
    expect(pause).toBeGreaterThan(confirmedDrift);
    expect(exit).toBeGreaterThan(pause);
    expect(repair).toBeGreaterThan(exit);
    expect(source).toContain('manualRemoteMissingObserved');
  });

  it('offers only explicit accept-Nitrado or restore-V-Bot decisions behind fresh remote reads', () => {
    const route = read('src/dashboard/routes/v2/nitradoDrift.ts');
    const v2 = read('src/dashboard/routes/v2.ts');

    expect(v2).toContain("v2Router.use('/guilds/:guildId/nitrado-drift', nitradoDriftRouter)");
    expect(route).toContain("type DriftDecision = 'ACCEPT_NITRADO' | 'RESTORE_VBOT'");
    expect(route).toContain("nitradoDriftRouter.get('/whitelist'");
    expect(route).toContain("nitradoDriftRouter.post('/whitelist/resolve'");
    expect(route).toContain("nitradoDriftRouter.get('/bans'");
    expect(route).toContain("nitradoDriftRouter.post('/bans/resolve'");
    expect(route).toContain('readCurrentAdmBinding');
    expect(route).toContain('withFreshAdmBinding');
    expect(route).toContain("action: 'NITRADO_WHITELIST_DRIFT_RESTORE'");
    expect(route).toContain("action: 'NITRADO_BAN_DRIFT_RESTORE'");
    expect(route).toContain("data: { syncState: 'LOCAL_ONLY', lastSyncedAt: null }");
    expect(route).toContain("data: { active: false, appliedRemotely: false, liftedAt: now }");
  });

  it('surfaces the conflict globally on server-slot dashboard pages with both decisions', () => {
    const shell = read('dashboard-ui/src/components/Shell.tsx');
    const banner = read('dashboard-ui/src/components/NitradoDriftBanner.tsx');

    expect(shell).toContain("/^\\/servers\\/([^/]+)\\/server\\/([1-5])");
    expect(shell).toContain('<NitradoDriftBanner');
    expect(banner).toContain('Manuelle Nitrado-Abweichung erkannt');
    expect(banner).toContain('Nitrado-Zustand uebernehmen');
    expect(banner).toContain('V-Bot-Zustand wiederherstellen');
    expect(banner).toContain("decision: 'ACCEPT_NITRADO'");
    expect(banner).toContain("decision: 'RESTORE_VBOT'");
    expect(banner).toContain('btn-premium');
  });
});
