import fs from 'node:fs';
import { normalizeSourceNewlines } from '../helpers/sourceText';
import path from 'node:path';

const worker = normalizeSourceNewlines(fs.readFileSync(
  path.resolve(process.cwd(), 'src/modules/nitrado/jobWorker.ts'),
  'utf8',
));

describe('Nitrado-1K worker error taxonomy gate', () => {
  it('haelt connect+lock-query gemeinsam im Cleanup-try', () => {
    const fn = worker.indexOf('async function tryAcquireConnectionLock(');
    const tryBlock = worker.indexOf('try {', fn);
    const connect = worker.indexOf('await client.connect();', fn);
    const query = worker.indexOf("SELECT pg_try_advisory_lock($1, $2) AS locked", connect);
    const cleanup = worker.indexOf('await client.end().catch(() => undefined);', query);

    expect(fn).toBeGreaterThanOrEqual(0);
    expect(tryBlock).toBeGreaterThan(fn);
    expect(connect).toBeGreaterThan(tryBlock);
    expect(query).toBeGreaterThan(connect);
    expect(cleanup).toBeGreaterThan(query);
  });

  it('trennt normalen Lock-Contention von Lock-Infrastrukturfehlern', () => {
    const execute = worker.indexOf('export async function executeJob(');
    const acquire = worker.indexOf('connectionLock = await tryAcquireConnectionLock(job.nitradoConnId);', execute);
    const infraCatch = worker.indexOf('Connection-Lock-Infrastruktur fehlgeschlagen:', acquire);
    const infraFail = worker.indexOf('await failJob(', acquire);
    const transientFalse = worker.indexOf('\n        false,', infraFail);
    const busyBranch = worker.indexOf('if (!connectionLock) {', infraCatch);
    const busyRequeue = worker.indexOf('await requeueForConnectionLock(claim);', busyBranch);

    expect(acquire).toBeGreaterThan(execute);
    expect(infraFail).toBeGreaterThan(acquire);
    expect(infraCatch).toBeGreaterThan(infraFail);
    expect(transientFalse).toBeGreaterThan(infraCatch);
    expect(busyBranch).toBeGreaterThan(transientFalse);
    expect(busyRequeue).toBeGreaterThan(busyBranch);
    expect(worker.slice(acquire, busyBranch)).not.toContain('requeueForConnectionLock(claim)');
  });

  it('behandelt DB-Lookup-Ausfall transient, fehlende/inaktive Connection aber permanent', () => {
    const lookup = worker.indexOf('conn = await prisma.nitradoConnection.findFirst({');
    const lookupError = worker.indexOf('Connection-Lookup fehlgeschlagen:', lookup);
    const transientFalse = worker.indexOf('\n          false,', lookupError);
    const missingConnection = worker.indexOf("'Connection inaktiv oder geloescht'", transientFalse);
    const permanentTrue = worker.indexOf('\n          true,', missingConnection);

    expect(lookup).toBeGreaterThanOrEqual(0);
    expect(lookupError).toBeGreaterThan(lookup);
    expect(transientFalse).toBeGreaterThan(lookupError);
    expect(missingConnection).toBeGreaterThan(transientFalse);
    expect(permanentTrue).toBeGreaterThan(missingConnection);
  });

  it('klassifiziert lokale Service-/Payload-Vertragsfehler permanent', () => {
    expect(worker).toContain("throw new PermanentJobError('Kein nitradoServerId fuer WHITELIST_ADD')");
    expect(worker).toContain("throw new PermanentJobError('Kein nitradoServerId fuer WHITELIST_REMOVE')");
    expect(worker).toContain("throw new PermanentJobError('Kein nitradoServerId fuer RESTART_IF_DOWN')");
    expect(worker).toContain("throw new PermanentJobError('payload.gameId fehlt')");

    const helper = worker.indexOf('function parsePermanentServerBanPayload(value: unknown)');
    const parser = worker.indexOf('return parseServerBanJobPayload(value);', helper);
    const wrappedPermanent = worker.indexOf('throw new PermanentJobError(', parser);
    const addUse = worker.indexOf('const banPayload = parsePermanentServerBanPayload(payload);', wrappedPermanent);
    const removeUse = worker.indexOf('const banPayload = parsePermanentServerBanPayload(payload);', addUse + 1);

    expect(helper).toBeGreaterThanOrEqual(0);
    expect(parser).toBeGreaterThan(helper);
    expect(wrappedPermanent).toBeGreaterThan(parser);
    expect(addUse).toBeGreaterThan(wrappedPermanent);
    expect(removeUse).toBeGreaterThan(addUse);
  });

  it('behaelt Nitrado-429 transient und andere 4xx permanent', () => {
    expect(worker).toContain('httpStatus >= 400 && httpStatus < 500 && httpStatus !== 429');
    expect(worker).toContain('e instanceof PermanentJobError');
  });
});
