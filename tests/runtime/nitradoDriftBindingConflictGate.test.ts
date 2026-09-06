import fs from 'node:fs';
import path from 'node:path';
import { normalizeSourceNewlines } from '../helpers/sourceText';

function read(relative: string): string {
  return normalizeSourceNewlines(fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8'));
}

function between(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('Nitrado drift binding conflict gate', () => {
  const route = read('src/dashboard/routes/v2/nitradoDrift.ts');
  const bindingFence = read('src/modules/nitrado/adm/bindingFence.ts');
  const configLock = read('src/modules/nitrado/configMutationLock.ts');
  const liveSync = read('src/modules/nitrado/adm/admLiveSyncCron.ts');

  it('keeps the canonical per-connection lock fail-closed and non-blocking', () => {
    expect(configLock).toContain("SELECT pg_try_advisory_lock($1, $2) AS locked");
    expect(configLock).toContain('if (result.rows?.[0]?.locked !== true)');
    expect(configLock).toContain('return null;');
    expect(bindingFence).toContain('if (!lock) throw new AdmBindingBusyError();');
  });

  it('classifies initial dashboard drift binding contention as HTTP 409 instead of leaking to the global 500 handler', () => {
    const helper = between(route, 'async function readBinding(', 'function safeDecryptIdentifier(');
    const tryAt = helper.indexOf('try {');
    const readAt = helper.indexOf('await readCurrentAdmBinding(');
    const classifyAt = helper.indexOf('isAdmBindingFenceError(error)');
    const conflictAt = helper.indexOf('res.status(409).json(', classifyAt);
    const returnAt = helper.indexOf('return null;', conflictAt);
    const rethrowAt = helper.indexOf('throw error;', returnAt);

    expect(tryAt).toBeGreaterThanOrEqual(0);
    expect(readAt).toBeGreaterThan(tryAt);
    expect(classifyAt).toBeGreaterThan(readAt);
    expect(conflictAt).toBeGreaterThan(classifyAt);
    expect(returnAt).toBeGreaterThan(conflictAt);
    expect(rethrowAt).toBeGreaterThan(returnAt);
    expect(helper).toContain('Nitrado-Verbindung wird gerade sicher verarbeitet oder parallel geaendert. Bitte erneut laden.');
  });

  it('does not hide unrelated database or infrastructure failures as expected contention', () => {
    const helper = between(route, 'async function readBinding(', 'function safeDecryptIdentifier(');
    expect(helper).toContain('if (isAdmBindingFenceError(error))');
    expect(helper).toContain('throw error;');
    expect(helper).not.toContain('catch {');
  });

  it('routes all four drift surfaces through the same protected initial binding snapshot', () => {
    expect((route.match(/const resolved = await readBinding\(scope, req\.query\.slot, res\);/g) ?? [])).toHaveLength(4);
    expect(route).toContain("nitradoDriftRouter.get('/whitelist'");
    expect(route).toContain("nitradoDriftRouter.post('/whitelist/resolve'");
    expect(route).toContain("nitradoDriftRouter.get('/bans'");
    expect(route).toContain("nitradoDriftRouter.post('/bans/resolve'");
  });

  it('preserves post-remote freshness revalidation and does not add lock polling or sleep loops', () => {
    const helper = between(route, 'async function readBinding(', 'function safeDecryptIdentifier(');
    expect(route).toContain('await withFreshAdmBinding(binding, async () => undefined);');
    expect(route).toContain('const result = await withFreshAdmBinding(binding, () => prisma.$transaction(async tx => {');
    expect(helper).not.toContain('setTimeout');
    expect(helper).not.toContain('sleep');
    expect(helper).not.toContain('retry');
  });

  it('keeps background ADM polling contention low-noise instead of treating it as a runtime failure', () => {
    expect(liveSync).toContain('if (isAdmBindingFenceError(error)) logger.debug(`ADM-Live-Sync ${scope.id}: Binding-Lock busy/stale, Poll verworfen.`);');
  });
});
