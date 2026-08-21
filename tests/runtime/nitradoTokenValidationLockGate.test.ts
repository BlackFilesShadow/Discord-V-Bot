import fs from 'node:fs';
import { normalizeSourceNewlines } from '../helpers/sourceText';
import path from 'node:path';

const read = (relative: string) => normalizeSourceNewlines(fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8'));

const cron = read('src/modules/nitrado/tokenValidationCron.ts');
const configLock = read('src/modules/nitrado/configMutationLock.ts');
const worker = read('src/modules/nitrado/jobWorker.ts');

describe('Nitrado-1D token validation lock/snapshot architecture gate', () => {
  it('uses the established config/worker connection lock instead of a separate lock namespace', () => {
    expect(cron).toContain("import { tryAcquireNitradoConfigMutationLock } from './configMutationLock';");
    expect(cron).toContain('lock = await tryAcquireNitradoConfigMutationLock(conn.id);');

    // 1C already proves configMutationLock and worker share the same PG key.
    // 1D must consume that boundary rather than clone advisory-lock logic.
    expect(configLock).toContain('const CONN_LOCK_NAMESPACE = 0x4e495452;');
    expect(worker).toContain('const CONN_LOCK_NAMESPACE = 0x4e495452;');
    expect(cron).not.toContain('CONN_LOCK_NAMESPACE');
    expect(cron).not.toContain('pg_try_advisory_lock');
    expect(cron).not.toContain("from 'pg'");
  });

  it('acquires the connection lock before re-reading the canonical DB snapshot', () => {
    const entryAt = cron.indexOf('export async function validateConnectionTokenOnce(');
    const lockAt = cron.indexOf('await tryAcquireNitradoConfigMutationLock(conn.id)', entryAt);
    const freshReadAt = cron.indexOf('fresh = await prisma.nitradoConnection.findFirst({', entryAt);
    const lockedValidationAt = cron.indexOf('await validateLockedConnectionTokenOnce(discord, fresh);', entryAt);

    expect(entryAt).toBeGreaterThanOrEqual(0);
    expect(lockAt).toBeGreaterThan(entryAt);
    expect(freshReadAt).toBeGreaterThan(lockAt);
    expect(lockedValidationAt).toBeGreaterThan(freshReadAt);

    const freshReadSection = cron.slice(freshReadAt, lockedValidationAt);
    expect(freshReadSection).toContain('id: conn.id');
    expect(freshReadSection).toContain('guildId: conn.guildId');
    expect(freshReadSection).toContain("status: { in: ['ACTIVE', 'EXPIRED'] }");
    expect(freshReadSection).toContain('encryptedToken: true');
  });

  it('validates and writes from the fresh locked snapshot, never the scan token', () => {
    const lockedHelperAt = cron.indexOf('async function validateLockedConnectionTokenOnce(');
    const publicEntryAt = cron.indexOf('export async function validateConnectionTokenOnce(');
    const pollAt = cron.indexOf('async function pollOnce(');

    expect(lockedHelperAt).toBeGreaterThanOrEqual(0);
    expect(publicEntryAt).toBeGreaterThan(lockedHelperAt);
    expect(pollAt).toBeGreaterThan(publicEntryAt);

    const lockedHelper = cron.slice(lockedHelperAt, publicEntryAt);
    expect(lockedHelper).toContain('decrypt(conn.encryptedToken, config.security.encryptionKey)');
    expect(lockedHelper).toContain('await client.validateTokenDetailed()');
    expect(lockedHelper).toContain('await markValidated(asGuildId(conn.guildId), asNitradoConnId(conn.id));');
    expect(lockedHelper).toContain("await setStatus(asGuildId(conn.guildId), asNitradoConnId(conn.id), 'EXPIRED');");

    const entrySection = cron.slice(publicEntryAt, pollAt);
    expect(entrySection).toContain('await validateLockedConnectionTokenOnce(discord, fresh);');
    expect(entrySection).not.toContain('validateLockedConnectionTokenOnce(discord, conn)');
  });

  it('treats busy/lock/snapshot failures as infrastructure and releases every acquired lock', () => {
    const entryAt = cron.indexOf('export async function validateConnectionTokenOnce(');
    const pollAt = cron.indexOf('async function pollOnce(', entryAt);
    const entrySection = cron.slice(entryAt, pollAt);

    expect(entrySection).toContain('if (!lock) {');
    expect(entrySection).toContain('return;');
    expect(entrySection).toContain('Token-Validation-Lock');
    expect(entrySection).toContain('Token-Validation-Snapshot');
    expect(entrySection).toContain('finally {\n    await lock.release();\n  }');

    // Infrastructure paths must not poison validation-health for a token that
    // was never actually validated under a canonical snapshot.
    const lockFailureAt = entrySection.indexOf('Token-Validation-Lock');
    const freshReadAt = entrySection.indexOf('fresh = await prisma.nitradoConnection.findFirst({');
    expect(entrySection.slice(0, freshReadAt)).not.toContain('persistFailure(');
    expect(lockFailureAt).toBeGreaterThanOrEqual(0);
  });

  it('keeps the outer scan as candidate discovery only and never persists failures from its stale snapshot', () => {
    const pollAt = cron.indexOf('async function pollOnce(');
    const pollSection = cron.slice(pollAt);

    expect(pollSection).toContain('await validateConnectionTokenOnce(discord, c);');
    expect(pollSection).not.toContain('persistFailure(discord, c');
  });
});
