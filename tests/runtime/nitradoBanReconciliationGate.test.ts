import fs from 'node:fs';
import path from 'node:path';

const read = (relative: string): string => fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8');

describe('Nitrado-1X ban reconciliation architecture', () => {
  it('freshens connection state under the canonical lock before reconciliation', () => {
    const source = read('src/modules/bans/banReconciliation.ts');
    const fn = source.indexOf('async function reconcileConnection');
    const lock = source.indexOf('tryAcquireNitradoConfigMutationLock(candidate.id)', fn);
    const fresh = source.indexOf('prisma.nitradoConnection.findFirst', lock);
    const work = source.indexOf('await reconcileLockedConnection(fresh, now)', fresh);

    expect(fn).toBeGreaterThanOrEqual(0);
    expect(lock).toBeGreaterThan(fn);
    expect(fresh).toBeGreaterThan(lock);
    expect(work).toBeGreaterThan(fresh);
    expect(source).toContain('guildId: candidate.guildId');
    expect(source).not.toContain('serverBanEntries: { some: {} }');
  });

  it('queries exact local ban scope before any remote Banlist request', () => {
    const source = read('src/modules/bans/banReconciliation.ts');
    const localQuery = source.indexOf('const local = await prisma.serverBanEntry.findMany');
    const localEmpty = source.indexOf('if (local.length === 0) return;', localQuery);
    const remoteRead = source.indexOf('.getBanlist(conn.nitradoServerId)', localEmpty);
    const local = source.slice(localQuery, localEmpty);

    expect(localQuery).toBeGreaterThanOrEqual(0);
    expect(local).toContain('guildId: conn.guildId');
    expect(local).toContain('nitradoConnId: conn.id');
    expect(localEmpty).toBeGreaterThan(localQuery);
    expect(remoteRead).toBeGreaterThan(localEmpty);
    expect(source).toContain('Unbekannte Remote-Bans werden nie');
  });

  it('uses encrypted durable identity, race-safe cleanup and bounded automatic ADD retries', () => {
    const model = read('prisma/server-ban-remote-identity.prisma');
    const migration = read('prisma/migrations/20260819054500_server_ban_remote_identity/migration.sql');
    const outbox = read('src/modules/bans/banOutbox.ts');

    expect(model).toContain('model ServerBanRemoteIdentity');
    expect(model).toContain('identifierEnc String');
    expect(migration).toContain('REFERENCES "ServerBanEntry"("id")');
    expect(migration).toContain('ON DELETE CASCADE');
    expect(migration).toContain('cleanup_server_ban_remote_identity');
    expect(migration).toContain('guard_server_ban_remote_identity');
    expect(migration).toContain('guard_server_ban_remote_identity_delete');
    expect(migration).toContain('pg_trigger_depth() = 1');
    expect(migration).toContain('NEW."active" = FALSE AND NEW."appliedRemotely" = FALSE');
    expect(outbox.indexOf('serverBanRemoteIdentity.upsert')).toBeLessThan(
      outbox.indexOf('const existing = await tx.nitradoJob.findMany'),
    );
    expect(outbox).toContain('SERVER_BAN_ADD_AUTO_DEAD_COOLDOWN_MS');
  });

  it('is wired into central Nitrado runtime start and stop', () => {
    const runtime = read('src/modules/nitrado/runtime.ts');
    expect(runtime).toContain("from '../bans/banReconciliation'");
    expect(runtime).toContain('startBanReconciliationCron();');
    expect(runtime).toContain('stopBanReconciliationCron();');
  });
});
