import fs from 'node:fs';
import path from 'node:path';
import { normalizeSourceNewlines } from '../helpers/sourceText';

const read = (relative: string): string => normalizeSourceNewlines(
  fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8'),
);

describe('Nitrado drift stability gate', () => {
  const whitelistOutbox = read('src/modules/whitelist/whitelistOutbox.ts');
  const banOutbox = read('src/modules/bans/banOutbox.ts');
  const whitelistSync = read('src/modules/whitelist/whitelistSyncCron.ts');
  const banReconcile = read('src/modules/bans/banReconciliation.ts');
  const driftRoute = read('src/dashboard/routes/v2/nitradoDrift.ts');

  it('canonicalizes every whitelist remove intent case-insensitively before the outbox job', () => {
    const helper = whitelistOutbox.indexOf('export async function markWhitelistRemoveIntent(');
    const insensitive = whitelistOutbox.indexOf("mode: 'insensitive' as const", helper);
    const ensure = whitelistOutbox.indexOf('async function ensureWhitelistJobInLock(');
    const mark = whitelistOutbox.indexOf('await markWhitelistRemoveIntent(tx, scope, gameId);', ensure);
    const create = whitelistOutbox.indexOf('await tx.nitradoJob.create({', ensure);

    expect(helper).toBeGreaterThanOrEqual(0);
    expect(insensitive).toBeGreaterThan(helper);
    expect(mark).toBeGreaterThan(ensure);
    expect(create).toBeGreaterThan(mark);
  });

  it('forces every server-ban ADD through the same case-insensitive whitelist remove intent', () => {
    expect(banOutbox).toContain("import { markWhitelistRemoveIntent } from '../whitelist/whitelistOutbox';");
    const ensure = banOutbox.indexOf('async function ensureJobInLock(');
    const mark = banOutbox.indexOf('await markWhitelistRemoveIntent(tx, scope, options.whitelistIdentifier);', ensure);
    const identity = banOutbox.indexOf('serverBanRemoteIdentity.upsert({', ensure);
    const enqueue = banOutbox.indexOf('export async function enqueueServerBanAdd(');
    const rawPass = banOutbox.indexOf('whitelistIdentifier: identifier', enqueue);

    expect(mark).toBeGreaterThan(ensure);
    expect(identity).toBeGreaterThan(mark);
    expect(rawPass).toBeGreaterThan(enqueue);
  });

  it('does not surface whitelist drift when the V-Bot whitelist is disabled', () => {
    const route = driftRoute.indexOf("nitradoDriftRouter.get('/whitelist'");
    const settingsRead = driftRoute.indexOf('select: { whitelistActive: true }', route);
    const disabled = driftRoute.indexOf("if (!settings?.whitelistActive)", settingsRead);
    const remoteRead = driftRoute.indexOf('.getWhitelist(binding.nitradoServerId)', disabled);

    expect(settingsRead).toBeGreaterThan(route);
    expect(disabled).toBeGreaterThan(settingsRead);
    expect(remoteRead).toBeGreaterThan(disabled);
  });

  it('requires a second remote observation before dashboard drift is emitted', () => {
    expect(driftRoute).toContain('const DRIFT_CONFIRM_DELAY_MS = 350;');
    expect(driftRoute).toContain('const firstMissing = local.filter');
    expect(driftRoute).toContain('await delay(DRIFT_CONFIRM_DELAY_MS);');
    expect(driftRoute).toContain('confirmedMissing = firstMissing.filter');
    expect(driftRoute).toContain('const items = confirmedMissing.map');

    const whitelistReads = driftRoute.match(/getWhitelist\(binding\.nitradoServerId\)/g) ?? [];
    const banReads = driftRoute.match(/getBanlist\(binding\.nitradoServerId\)/g) ?? [];
    expect(whitelistReads.length).toBeGreaterThanOrEqual(3); // GET first+confirm plus resolve read
    expect(banReads.length).toBeGreaterThanOrEqual(3); // GET first+confirm plus resolve read
  });

  it('matches confirmed bans by the encrypted original identifier case-insensitively', () => {
    expect(driftRoute).toContain('function banPresentRemotely(');
    expect(driftRoute).toContain('const expected = norm(storedIdentifier);');
    expect(driftRoute).toContain('remoteIdentifiers.some(identifier => norm(identifier) === expected)');
    expect(driftRoute).not.toContain('const remoteHashes = new Set(');

    expect(banReconcile).toContain('function findRemoteIdentifier(');
    expect(banReconcile).toContain('const target = normIdentifier(storedIdentifier);');
    expect(banReconcile).toContain('normIdentifier(row.identifier) === target');
  });

  it('requires stable remote absence in both background reconcilers', () => {
    expect(whitelistSync).toContain('const REMOTE_ABSENCE_CONFIRM_DELAY_MS = 350;');
    expect(whitelistSync).toContain('remoteNames = mergeRemoteNames(remoteNames, secondRemoteNames);');
    expect(whitelistSync).toContain('Abwesenheit gilt nur, wenn beide Reads fehlen');

    expect(banReconcile).toContain('const REMOTE_ABSENCE_CONFIRM_DELAY_MS = 350;');
    expect(banReconcile).toContain('remoteRows = mergeRemoteRows(remoteRows, await api.getBanlist(conn.nitradoServerId));');
    expect(banReconcile).toContain('Abwesenheit gilt nur, wenn beide Reads fehlen');
  });

  it('keeps drift resolution itself case-insensitive for whitelist rows and requests', () => {
    const resolve = driftRoute.indexOf("nitradoDriftRouter.post('/whitelist/resolve'");
    expect(resolve).toBeGreaterThanOrEqual(0);
    const tail = driftRoute.slice(resolve, driftRoute.indexOf("nitradoDriftRouter.get('/bans'", resolve));
    expect(tail).toContain("gameId: { equals: gameId, mode: 'insensitive' }");
    expect(tail).toContain("gameId: { equals: row.gameId, mode: 'insensitive' }");
  });
});