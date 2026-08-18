import fs from 'fs';
import path from 'path';

const ROOT = path.join(__dirname, '..', '..');
function source(file: string): string {
  return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

function expectOrdered(text: string, first: string, second: string): void {
  const a = text.indexOf(first);
  const b = text.indexOf(second);
  expect(a).toBeGreaterThanOrEqual(0);
  expect(b).toBeGreaterThan(a);
}

describe('Nitrado-1M ADM binding freshness architecture gate', () => {
  it('backfillt bestehende Connections auf legacy-kompatibler Binding-Version 0', () => {
    const schema = source('prisma/nitrado-adm-binding.prisma');
    const migration = source('prisma/migrations/20260818180000_nitrado_1m_adm_binding_state/migration.sql');
    const state = source('src/modules/nitrado/adm/bindingState.ts');

    expect(schema).toContain('model NitradoAdmBindingState');
    expect(schema).toContain('bindingVersion   Int      @default(0)');
    expect(migration).toContain('INSERT INTO "NitradoAdmBindingState"');
    expect(migration).toContain('SELECT\n    "guildId", "id", 0, "nitradoServerId"');
    expect(state).toContain("return bindingVersion === 0 ? null : `adm-binding:${bindingVersion}:`;");
    expect(state).toContain('bindingVersion: { increment: 1 }');
  });

  it('versioniert Service-Rebind und Profilverifikation in derselben Repository-Transaktion', () => {
    const repo = source('src/modules/nitrado/repository.ts');
    const updateService = repo.slice(repo.indexOf('export async function updateServiceId'));
    const firstBindingSync = updateService.indexOf('await syncAdmBindingState(');
    const serviceWrite = updateService.indexOf('data: { nitradoServerId, serviceId: nitradoServerId }');
    const secondBindingSync = updateService.indexOf('await syncAdmBindingState(', firstBindingSync + 1);

    expect(updateService).toContain('prisma.$transaction(async tx =>');
    expect(updateService).toContain('before.nitradoServerId');
    expect(updateService).toContain('data: { lastVerifiedAt: null, lastError: null }');
    expect(firstBindingSync).toBeGreaterThanOrEqual(0);
    expect(serviceWrite).toBeGreaterThan(firstBindingSync);
    expect(secondBindingSync).toBeGreaterThan(serviceWrite);
  });

  it('fenced Side-Effects gegen exakten ACTIVE Token+Service+Binding-Snapshot', () => {
    const fence = source('src/modules/nitrado/adm/bindingFence.ts');

    expect(fence).toContain('tryAcquireNitradoConfigMutationLock(snapshot.id)');
    expect(fence).toContain("status: 'ACTIVE'");
    expect(fence).toContain('encryptedToken: snapshot.encryptedToken');
    expect(fence).toContain('nitradoServerId: snapshot.nitradoServerId');
    expect(fence).toContain('binding.bindingVersion !== snapshot.bindingVersion');
    expectOrdered(fence, 'binding.bindingVersion !== snapshot.bindingVersion', 'return await work();');
    expectOrdered(fence, 'return await work();', 'await lock.release();');
  });

  it('scannt Live-ADM nur per stabiler ID und fenced Cursor, Links und Source-Health', () => {
    const live = source('src/modules/nitrado/adm/admLiveSyncCron.ts');

    expect(live).toContain('select: { id: true, guildId: true }');
    expect(live).not.toContain('select: { id: true, guildId: true, encryptedToken: true, nitradoServerId: true }');
    expect(live).toContain('readCurrentAdmBinding(scope)');
    expect(live).toContain('admBindingFileIdentity(conn.bindingVersion, file.name)');
    expect(live).toContain('admBindingFileIdentityPrefix(conn.bindingVersion)');
    expect(live).toContain('sourceFile: sourceIdentity');
    expect(live).toContain('await withFreshAdmBinding(conn, async () => {\n      await persistAdmEvents(');
    expect(live).toContain('await verifyLinkChallengesUnsafe(conn, chunk);');
    expect(live).toContain('async function setSourceStatus');
    expect(live).toContain('await withFreshAdmBinding(conn, async () => {');
  });

  it('fenced auch Dashboard-Profilwrites und verwendet keinen separat gelesenen Token mehr', () => {
    const route = source('src/dashboard/routes/v2/admSource.ts');

    expect(route).not.toContain('getDecryptedToken');
    expect(route).toContain('readCurrentAdmBinding({ id: found.id, guildId })');
    expect(route).toContain('withFreshAdmBinding(ctx.binding, work)');
    expect(route).toContain('await writeFence(() => prisma.nitradoAdmProfileConfig.deleteMany({');
    expect(route).toContain('res.status(409)');
  });

  it('haelt echten Cursor-Dateinamen und namespaceten Event-Source-Key getrennt', () => {
    const ingestor = source('src/modules/nitrado/adm/serverLogIngestor.ts');

    expect(ingestor).toContain('sourceFile?: string;');
    expect(ingestor).toContain('sourceFile: meta.sourceFile ?? meta.fileName');
    expect(ingestor).toContain('fileName: meta.fileName');
  });
});
