import fs from 'node:fs';
import path from 'node:path';

const read = (relative: string) => fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8');

const worker = read('src/modules/nitrado/jobWorker.ts');
const configLock = read('src/modules/nitrado/configMutationLock.ts');
const repository = read('src/modules/nitrado/repository.ts');
const schema = read('prisma/schema.prisma');

function capture(source: string, expression: RegExp, label: string): string {
  const match = source.match(expression);
  if (!match?.[1]) throw new Error(`Nitrado-1C verification: ${label} nicht gefunden`);
  return match[1];
}

describe('Nitrado-1C post-merge verification gate', () => {
  it('proves worker and config mutations use the exact same advisory-lock namespace', () => {
    const workerNamespace = capture(
      worker,
      /const CONN_LOCK_NAMESPACE = (0x[0-9a-f]+);/i,
      'Worker-Namespace',
    );
    const configNamespace = capture(
      configLock,
      /const CONN_LOCK_NAMESPACE = (0x[0-9a-f]+);/i,
      'Config-Namespace',
    );

    expect(workerNamespace).toBe('0x4e495452');
    expect(configNamespace).toBe(workerNamespace);
  });

  it('proves both lock boundaries derive the second pg key from SHA-256 + readInt32BE(0)', () => {
    for (const source of [worker, configLock]) {
      expect(source).toContain("createHash('sha256').update(nitradoConnId).digest()");
      expect(source).toContain('digest.readInt32BE(0)');
      expect(source).toContain("SELECT pg_try_advisory_lock($1, $2) AS locked");
      expect(source).toContain("SELECT pg_advisory_unlock($1, $2)");
    }
  });

  it('forbids a third independent session-lock implementation in the Nitrado module', () => {
    const dir = path.resolve(process.cwd(), 'src/modules/nitrado');
    const files = fs.readdirSync(dir).filter(name => name.endsWith('.ts'));
    const lockOwners = files.filter(name => read(`src/modules/nitrado/${name}`).includes('pg_try_advisory_lock'));

    expect(lockOwners.sort()).toEqual(['configMutationLock.ts', 'jobWorker.ts']);
  });

  it('keeps token, service and delete mutations inside a release-in-finally boundary', () => {
    const lockHelper = repository.slice(
      repository.indexOf('async function withConfigMutationLock<T>('),
      repository.indexOf('function rowToConn('),
    );
    expect(lockHelper).toContain('const lock = await tryAcquireNitradoConfigMutationLock(nitradoConnId);');
    expect(lockHelper).toContain('if (!lock) throw new NitradoConnectionBusyError();');
    expect(lockHelper).toContain('finally {');
    expect(lockHelper).toContain('await lock.release();');

    const deleteAt = repository.indexOf('export async function deleteSlot(');
    const tokenAt = repository.indexOf('export async function updateToken(');
    const serviceAt = repository.indexOf('export async function updateServiceId(');
    expect(repository.indexOf('return withConfigMutationLock(targetId, async () => {', deleteAt)).toBeGreaterThan(deleteAt);
    expect(repository.indexOf('return withConfigMutationLock(targetId, async () => {', tokenAt)).toBeGreaterThan(tokenAt);
    expect(repository.indexOf('return withConfigMutationLock(targetId, async () => {', serviceAt)).toBeGreaterThan(serviceAt);
  });

  it('proves NitradoJob rows cascade when their connection is deleted', () => {
    const modelStart = schema.indexOf('model NitradoJob {');
    expect(modelStart).toBeGreaterThanOrEqual(0);
    const modelEnd = schema.indexOf('\n}', modelStart);
    const model = schema.slice(modelStart, modelEnd + 2);

    expect(model).toContain(
      'nitradoConn NitradoConnection @relation(fields: [nitradoConnId], references: [id], onDelete: Cascade)',
    );
  });

  it('proves delete revalidates exact connection identity only after acquiring the worker-compatible lock', () => {
    const deleteAt = repository.indexOf('export async function deleteSlot(');
    const lockAt = repository.indexOf('return withConfigMutationLock(targetId, async () => {', deleteAt);
    const identityCheck = repository.indexOf('where: { id: targetId, guildId, slot }', lockAt);
    const cleanup = repository.indexOf('const scopedKnowledge = await prisma.guildKnowledgeScope.findMany', identityCheck);

    expect(lockAt).toBeGreaterThan(deleteAt);
    expect(identityCheck).toBeGreaterThan(lockAt);
    expect(cleanup).toBeGreaterThan(identityCheck);
  });
});
