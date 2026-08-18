import fs from 'node:fs';
import path from 'node:path';

const read = (relative: string) => fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8');

const outbox = read('src/modules/bans/banOutbox.ts');
const worker = read('src/modules/nitrado/jobWorker.ts');
const expiry = read('src/modules/bans/expiryRuntime.ts');
const command = read('src/commands/dashboard/serverBan.ts');

describe('Nitrado-1J automatic SERVER_BAN_REMOVE DEAD cooldown gate', () => {
  it('checks active jobs and recent DEAD history under the same subject lock before create', () => {
    const ensureInLock = outbox.indexOf('async function ensureJobInLock(');
    const activeQuery = outbox.indexOf("status: { in: ['PENDING', 'RUNNING'] }", ensureInLock);
    const deadQuery = outbox.indexOf("status: 'DEAD'", activeQuery);
    const deadAge = outbox.indexOf('updatedAt: { gte: new Date(now.getTime() - recentDeadCooldownMs) }', deadQuery);
    const deadBanMatch = outbox.indexOf('recentDead.some(job => asPayload(job.payload)?.banId === payload.banId)', deadAge);
    const create = outbox.indexOf('await tx.nitradoJob.create({', deadBanMatch);
    const subjectLock = outbox.indexOf('return withNitradoOutboxSubjectLock(client, lockSubject, tx =>');
    const lockedEnsure = outbox.indexOf('ensureJobInLock(tx, scope, operation, payload, options)', subjectLock);

    expect(ensureInLock).toBeGreaterThanOrEqual(0);
    expect(activeQuery).toBeGreaterThan(ensureInLock);
    expect(deadQuery).toBeGreaterThan(activeQuery);
    expect(deadAge).toBeGreaterThan(deadQuery);
    expect(deadBanMatch).toBeGreaterThan(deadAge);
    expect(create).toBeGreaterThan(deadBanMatch);
    expect(subjectLock).toBeGreaterThanOrEqual(0);
    expect(lockedEnsure).toBeGreaterThan(subjectLock);
  });

  it('keeps a bounded one-hour automatic cooldown and a named manual bypass', () => {
    expect(outbox).toContain('export const SERVER_BAN_REMOVE_AUTO_DEAD_COOLDOWN_MS = 60 * 60 * 1000;');
    expect(outbox).toContain('bypassRecentDeadCooldown?: boolean;');
    expect(outbox).toContain('recentDeadCooldownMs: options.bypassRecentDeadCooldown');
    expect(outbox).toContain('? 0');
    expect(outbox).toContain(': SERVER_BAN_REMOVE_AUTO_DEAD_COOLDOWN_MS');
  });

  it('allows only the explicit /server-unban path to bypass recent DEAD history', () => {
    expect(command).toContain('{ bypassRecentDeadCooldown: true }');
    expect(worker).toContain('await enqueueServerBanRemove(');
    expect(expiry).toContain('await enqueueServerBanRemove(');
    expect(worker).not.toContain('bypassRecentDeadCooldown');
    expect(expiry).not.toContain('bypassRecentDeadCooldown');
  });
});