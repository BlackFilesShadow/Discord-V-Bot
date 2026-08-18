import fs from 'node:fs';
import path from 'node:path';

const read = (relative: string) => fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8');

const worker = read('src/modules/nitrado/jobWorker.ts');
const intent = read('src/modules/nitrado/whitelistIntent.ts');
const serverBan = read('src/commands/dashboard/serverBan.ts');

describe('Nitrado-1B whitelist intent reconciliation architecture gate', () => {
  it('derives retry execution from the current local source-of-truth instead of job age', () => {
    expect(intent).toContain("export type WhitelistDesiredState = 'PRESENT' | 'PENDING_REMOVE' | 'UNTRACKED';");
    expect(intent).toContain("row.syncState !== 'PENDING_REMOVE'");
    expect(intent).toContain("row.syncState === 'PENDING_REMOVE'");
    expect(intent).toContain("operation === 'WHITELIST_ADD'");
    expect(intent).toContain("reason: 'SUPERSEDED_BY_REMOVE'");
    expect(intent).toContain("reason: 'SUPERSEDED_BY_PRESENT'");
  });

  it('checks whitelist intent after the per-connection lock but before token decryption and remote mutation', () => {
    const lock = worker.indexOf('connectionLock = await tryAcquireConnectionLock(job.nitradoConnId);');
    const intentCheck = worker.indexOf('decision = await decideWhitelistRemoteIntent(');
    const decrypt = worker.indexOf('const token = decrypt(conn.encryptedToken, config.security.encryptionKey);');
    const add = worker.indexOf('await client.addToWhitelist(conn.nitradoServerId, payload.gameId);');
    const remove = worker.indexOf('await client.removeFromWhitelist(conn.nitradoServerId, payload.gameId);');

    expect(lock).toBeGreaterThanOrEqual(0);
    expect(intentCheck).toBeGreaterThan(lock);
    expect(decrypt).toBeGreaterThan(intentCheck);
    expect(add).toBeGreaterThan(decrypt);
    expect(remove).toBeGreaterThan(decrypt);
  });

  it('finishes superseded jobs as explicit DONE no-ops without persisting the player identifier again', () => {
    expect(worker).toContain('async function finishSupersededWhitelistJob');
    expect(worker).toContain("status: 'DONE', lastError: null");
    expect(worker).toContain("logAudit('NITRADO_WHITELIST_JOB_SUPERSEDED'");
    expect(worker).not.toContain("NITRADO_WHITELIST_JOB_SUPERSEDED', 'NITRADO', {\n    gameId");
    expect(worker).toContain('if (!decision.execute) {');
    expect(worker).toContain('await finishSupersededWhitelistJob({');
  });

  it('keeps remote-only REMOVE valid while stale ADD without a local active row is discarded', () => {
    expect(intent).toContain("desiredState === 'PRESENT'");
    expect(intent).toContain("? { execute: true, desiredState, reason: 'CURRENT_INTENT' }");
    expect(intent).toContain("return desiredState === 'PRESENT'");
    expect(intent).toContain("? { execute: false, desiredState, reason: 'SUPERSEDED_BY_PRESENT' }");
    expect(intent).toContain(": { execute: true, desiredState, reason: 'CURRENT_INTENT' };");
  });

  it('keeps server-ban local whitelist intent at PENDING_REMOVE before its remote ban outbox is queued', () => {
    const tx = serverBan.indexOf('const stored = await prisma.$transaction(async tx => {');
    const pendingRemove = serverBan.indexOf("syncState: 'PENDING_REMOVE'", tx);
    const banWrite = serverBan.indexOf('await addBan(', pendingRemove);
    const banOutbox = serverBan.indexOf('const queued = await enqueueServerBanAdd(', banWrite);

    expect(tx).toBeGreaterThanOrEqual(0);
    expect(pendingRemove).toBeGreaterThan(tx);
    expect(banWrite).toBeGreaterThan(pendingRemove);
    expect(banOutbox).toBeGreaterThan(banWrite);
  });
});
