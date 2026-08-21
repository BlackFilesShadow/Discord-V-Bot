import fs from 'node:fs';
import { normalizeSourceNewlines } from '../helpers/sourceText';
import path from 'node:path';

const read = (relative: string) => normalizeSourceNewlines(fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8'));

const worker = read('src/modules/nitrado/jobWorker.ts');
const configLock = read('src/modules/nitrado/configMutationLock.ts');
const repository = read('src/modules/nitrado/repository.ts');
const route = read('src/dashboard/routes/v2/nitrado.ts');

describe('Nitrado-1C config mutation / worker serialization architecture gate', () => {
  it('keeps worker and owner mutations in the exact same advisory-lock namespace and hash scheme', () => {
    expect(worker).toContain('const CONN_LOCK_NAMESPACE = 0x4e495452;');
    expect(configLock).toContain('const CONN_LOCK_NAMESPACE = 0x4e495452;');
    expect(worker).toContain("createHash('sha256').update(nitradoConnId).digest()");
    expect(configLock).toContain("createHash('sha256').update(nitradoConnId).digest()");
    expect(worker).toContain("digest.readInt32BE(0)");
    expect(configLock).toContain("digest.readInt32BE(0)");
    expect(worker).toContain("SELECT pg_try_advisory_lock($1, $2) AS locked");
    expect(configLock).toContain("SELECT pg_try_advisory_lock($1, $2) AS locked");
  });

  it('centralizes token, service and delete mutations behind the config mutation lock', () => {
    expect(repository).toContain("import { tryAcquireNitradoConfigMutationLock } from './configMutationLock';");
    expect(repository).toContain('export class NitradoConnectionBusyError extends Error');
    expect(repository).toContain('async function withConfigMutationLock<T>(');

    const deleteAt = repository.indexOf('export async function deleteSlot(');
    const tokenAt = repository.indexOf('export async function updateToken(');
    const serviceAt = repository.indexOf('export async function updateServiceId(');
    const aliasAt = repository.indexOf('export async function updateAlias(');

    expect(repository.indexOf('return withConfigMutationLock(targetId, async () => {', deleteAt)).toBeGreaterThan(deleteAt);
    expect(repository.indexOf('return withConfigMutationLock(targetId, async () => {', tokenAt)).toBeGreaterThan(tokenAt);
    expect(repository.indexOf('return withConfigMutationLock(targetId, async () => {', serviceAt)).toBeGreaterThan(serviceAt);

    const aliasSection = repository.slice(aliasAt);
    expect(aliasSection).not.toContain('withConfigMutationLock(');
  });

  it('re-verifies exact connection identity after delete lock acquisition before cleanup', () => {
    const deleteAt = repository.indexOf('export async function deleteSlot(');
    const lockAt = repository.indexOf('return withConfigMutationLock(targetId, async () => {', deleteAt);
    const verifyAt = repository.indexOf('where: { id: targetId, guildId, slot }', lockAt);
    const cleanupAt = repository.indexOf('const scopedKnowledge = await prisma.guildKnowledgeScope.findMany', verifyAt);
    const deleteWriteAt = repository.indexOf('prisma.nitradoConnection.deleteMany({ where: { id: targetId, guildId, slot } })', cleanupAt);

    expect(lockAt).toBeGreaterThan(deleteAt);
    expect(verifyAt).toBeGreaterThan(lockAt);
    expect(cleanupAt).toBeGreaterThan(verifyAt);
    expect(deleteWriteAt).toBeGreaterThan(cleanupAt);
  });

  it('maps a busy worker/config collision to explicit HTTP 409 for token, service and delete', () => {
    expect(route).toContain('NitradoConnectionBusyError');
    expect(route).toContain("code: 'NITRADO_CONNECTION_BUSY'");

    const tokenAt = route.indexOf("nitradoRouter.patch('/:slot/token'");
    const serviceAt = route.indexOf("nitradoRouter.patch('/:slot/service'");
    const deleteAt = route.indexOf("nitradoRouter.delete('/:slot'");

    expect(route.indexOf('if (e instanceof NitradoConnectionBusyError) { respondConnectionBusy(res); return; }', tokenAt)).toBeGreaterThan(tokenAt);
    expect(route.indexOf('if (e instanceof NitradoConnectionBusyError) { respondConnectionBusy(res); return; }', serviceAt)).toBeGreaterThan(serviceAt);
    expect(route.indexOf('if (e instanceof NitradoConnectionBusyError) { respondConnectionBusy(res); return; }', deleteAt)).toBeGreaterThan(deleteAt);
  });
});
