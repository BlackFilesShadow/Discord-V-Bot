import fs from 'node:fs';
import path from 'node:path';

const sync = fs.readFileSync(
  path.resolve(process.cwd(), 'src/modules/whitelist/whitelistSyncCron.ts'),
  'utf8',
);

describe('Nitrado-1N whitelist reconcile connection-lock gate', () => {
  it('verwendet dieselbe kanonische NITR-Lock-Grenze wie Worker/Config/Token-Validation', () => {
    expect(sync).toContain("import { tryAcquireNitradoConfigMutationLock } from '../nitrado/configMutationLock';");
    expect(sync).toContain('const lock = await tryAcquireNitradoConfigMutationLock(candidate.id);');
    expect(sync).toContain('if (!lock) {');
  });

  it('liest Token und Service erst nach Lockgewinn frisch fuer exakt id+guild', () => {
    const reconcile = sync.indexOf('async function reconcileConnection(candidate:');
    const acquire = sync.indexOf('const lock = await tryAcquireNitradoConfigMutationLock(candidate.id);', reconcile);
    const freshRead = sync.indexOf('const fresh = await prisma.nitradoConnection.findFirst({', acquire);
    const exactId = sync.indexOf('id: candidate.id,', freshRead);
    const exactGuild = sync.indexOf('guildId: candidate.guildId,', exactId);
    const active = sync.indexOf("status: 'ACTIVE',", exactGuild);
    const whitelistEnabled = sync.indexOf('serverSettings: { some: { whitelistActive: true } },', active);
    const reconcileFresh = sync.indexOf('await reconcileLockedConnection(fresh, client);', whitelistEnabled);

    expect(reconcile).toBeGreaterThanOrEqual(0);
    expect(acquire).toBeGreaterThan(reconcile);
    expect(freshRead).toBeGreaterThan(acquire);
    expect(exactId).toBeGreaterThan(freshRead);
    expect(exactGuild).toBeGreaterThan(exactId);
    expect(active).toBeGreaterThan(exactGuild);
    expect(whitelistEnabled).toBeGreaterThan(active);
    expect(reconcileFresh).toBeGreaterThan(whitelistEnabled);
  });

  it('verhindert stale Token-/Service-Nutzung aus dem aeusseren Scheduler-Scan', () => {
    const scan = sync.indexOf('const conns = await prisma.nitradoConnection.findMany({');
    const scanSelect = sync.indexOf('select: {', scan);
    const scanEnd = sync.indexOf('},\n    });', scanSelect);
    const scanSlice = sync.slice(scanSelect, scanEnd);

    expect(scanSlice).toContain('id: true');
    expect(scanSlice).toContain('guildId: true');
    expect(scanSlice).not.toContain('encryptedToken: true');
    expect(scanSlice).not.toContain('nitradoServerId: true');

    const locked = sync.indexOf('async function reconcileLockedConnection(');
    const decrypt = sync.indexOf('decrypt(conn.encryptedToken, config.security.encryptionKey);', locked);
    const remoteRead = sync.indexOf('await api.getWhitelist(conn.nitradoServerId);', decrypt);
    expect(decrypt).toBeGreaterThan(locked);
    expect(remoteRead).toBeGreaterThan(decrypt);
  });

  it('haelt Remote-Read, lokale Spiegelwrites und Outbox-Enqueue bis zum finally unter dem Lock', () => {
    const reconcile = sync.indexOf('async function reconcileConnection(candidate:');
    const tryBlock = sync.indexOf('try {', reconcile);
    const fresh = sync.indexOf('const fresh = await prisma.nitradoConnection.findFirst({', tryBlock);
    const work = sync.indexOf('await reconcileLockedConnection(fresh, client);', fresh);
    const finallyBlock = sync.indexOf('} finally {', work);
    const release = sync.indexOf('await lock.release();', finallyBlock);

    expect(tryBlock).toBeGreaterThan(reconcile);
    expect(fresh).toBeGreaterThan(tryBlock);
    expect(work).toBeGreaterThan(fresh);
    expect(finallyBlock).toBeGreaterThan(work);
    expect(release).toBeGreaterThan(finallyBlock);
  });

  it('laesst direkte Nitrado-Mutationen weiterhin ausschliesslich in der Outbox/Worker-Grenze', () => {
    expect(sync).toContain('enqueueWhitelistAdd(');
    expect(sync).toContain('enqueueWhitelistRemove(');
    expect(sync).not.toContain('addToWhitelist(');
    expect(sync).not.toContain('removeFromWhitelist(');
    expect(sync).not.toContain('nitradoJob.create({');
  });
});
