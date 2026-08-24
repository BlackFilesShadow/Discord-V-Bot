import fs from 'node:fs';
import { normalizeSourceNewlines } from '../helpers/sourceText';
import path from 'node:path';

const read = (relative: string) => normalizeSourceNewlines(fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8'));

const worker = read('src/modules/nitrado/jobWorker.ts');
const intent = read('src/modules/nitrado/whitelistIntent.ts');
const safety = read('src/modules/whitelist/whitelistJobSafety.ts');
const syncCron = read('src/modules/whitelist/whitelistSyncCron.ts');
const dashboardWhitelist = read('src/dashboard/routes/v2/whitelist.ts');
const serverBan = read('src/commands/dashboard/serverBan.ts');

describe('Nitrado-1B whitelist intent reconciliation architecture gate', () => {
  it('derives retry execution from the current local source-of-truth instead of job age', () => {
    expect(intent).toContain("export type WhitelistDesiredState = 'PRESENT' | 'PENDING_REMOVE' | 'UNTRACKED';");
    expect(intent).toContain("row.syncState !== 'PENDING_REMOVE'");
    expect(intent).toContain("row.syncState === 'PENDING_REMOVE'");
    expect(intent).toContain("operation === 'WHITELIST_ADD'");
    expect(intent).toContain("reason: 'SUPERSEDED_BY_REMOVE'");
    expect(intent).toContain("reason: 'SUPERSEDED_BY_PRESENT'");
    expect(intent).toContain("reason: 'UNTRACKED_REMOVE_NOT_AUTHORIZED'");
  });

  it('guarantees the opposite 1A outbox intent before a superseded job can finish', () => {
    expect(intent).toContain('export async function reconcileWhitelistRemoteIntent(');
    expect(intent).toContain("operation === 'WHITELIST_ADD'");
    expect(intent).toContain('await enqueueWhitelistRemove(outbox, scope, gameId)');
    expect(intent).toContain('await enqueueWhitelistAdd(outbox, scope, gameId)');
    expect(intent).toContain('compensationQueued');

    const reconcile = worker.indexOf('decision = await reconcileWhitelistRemoteIntent(');
    const superseded = worker.indexOf('if (!decision.execute) {', reconcile);
    const done = worker.indexOf('await finishSupersededWhitelistJob({', superseded);
    expect(reconcile).toBeGreaterThanOrEqual(0);
    expect(superseded).toBeGreaterThan(reconcile);
    expect(done).toBeGreaterThan(superseded);
  });

  it('checks whitelist intent after the per-connection lock but before token decryption and remote mutation', () => {
    const lock = worker.indexOf('connectionLock = await tryAcquireConnectionLock(job.nitradoConnId);');
    const preReconcile = worker.indexOf('decision = await reconcileWhitelistRemoteIntent(');
    const decrypt = worker.indexOf('const token = decrypt(conn.encryptedToken, config.security.encryptionKey);');
    const add = worker.indexOf('await client.addToWhitelist(conn.nitradoServerId, payload.gameId);');
    const remove = worker.indexOf('await client.removeFromWhitelist(conn.nitradoServerId, payload.gameId);');

    expect(lock).toBeGreaterThanOrEqual(0);
    expect(preReconcile).toBeGreaterThan(lock);
    expect(decrypt).toBeGreaterThan(preReconcile);
    expect(add).toBeGreaterThan(decrypt);
    expect(remove).toBeGreaterThan(decrypt);
  });

  it('reconciles again after both whitelist remote writes and before the fenced generic DONE checkpoint', () => {
    const add = worker.indexOf('await client.addToWhitelist(conn.nitradoServerId, payload.gameId);');
    const postAdd = worker.indexOf("await reconcileWhitelistRemoteIntent(\n              'WHITELIST_ADD'", add);
    const remove = worker.indexOf('await client.removeFromWhitelist(conn.nitradoServerId, payload.gameId);');
    const postRemove = worker.indexOf("await reconcileWhitelistRemoteIntent(\n              'WHITELIST_REMOVE'", remove);
    const done = worker.indexOf('const done = await transitionClaimedNitradoJob(claim, {', postRemove);

    expect(postAdd).toBeGreaterThan(add);
    expect(postRemove).toBeGreaterThan(remove);
    expect(done).toBeGreaterThan(postRemove);
  });

  it('finishes superseded jobs through the fenced DONE no-op without persisting the player identifier again', () => {
    const start = worker.indexOf('async function finishSupersededWhitelistJob');
    const end = worker.indexOf('export async function executeJob', start);
    const finish = worker.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(finish).toContain('transitionClaimedNitradoJob(args.claim');
    expect(finish).toContain("status: 'DONE'");
    expect(finish).toContain('lastError: null');
    expect(finish).toContain("logAudit('NITRADO_WHITELIST_JOB_SUPERSEDED'");
    expect(finish).not.toContain('gameId:');
  });

  it('requires marker PLUS active verified Bye identity before any UNTRACKED REMOVE can execute', () => {
    expect(safety).toContain("WHITELIST_REMOVE_SAFETY_INTENT = 'AUTHORIZED_REMOVE_V2'");
    expect(safety).toContain('removeSafetyIntent');
    expect(intent).toContain('async function hasAuthorizedVerifiedLeaveRemoveIntent(');
    expect(intent).toContain("operation: 'WHITELIST_REMOVE'");
    expect(intent).toContain("status: 'RUNNING'");
    expect(intent).toContain('matchingJobs.length !== 1 || !isAuthorizedWhitelistRemovePayload');
    expect(intent).toContain("requestType: 'PARTIAL_DELETION'");
    expect(intent).toContain("status: 'IN_PROGRESS'");
    expect(intent).toContain("details.step === 'WHITELIST'");
    expect(intent).toContain("details.stage === 'RUNNING'");
    expect(intent).toContain("status: 'VERIFIED'");
    expect(intent).toContain('identityHash(session.gameId, config.security.encryptionKey)');
    expect(intent).toContain('norm(session.playerName) !== target');
    expect(intent).toContain('return provenDiscordIds.size === 1;');
    expect(intent).toContain("reason: 'UNTRACKED_REMOVE_NOT_AUTHORIZED'");
  });

  it('keeps background reconciliation non-destructive for remote-only names', () => {
    expect(syncCron).toContain('const remoteOnly = diff.toRemove.filter');
    expect(syncCron).toContain('for (const gameId of pendingRemoveRemote.values())');
    expect(syncCron).toContain('remoteOnlyObserved: remoteOnly.length');
    expect(syncCron).not.toContain('for (const gameId of diff.toRemove)');
  });

  it('keeps dashboard pull/push/merge additive and forbids bulk whitelist deletion', () => {
    const start = dashboardWhitelist.indexOf("whitelistRouter.post('/sync'");
    const end = dashboardWhitelist.indexOf("whitelistRouter.get('/channels'", start);
    const syncRoute = dashboardWhitelist.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(syncRoute).toContain("if (direction === 'pull' || direction === 'merge')");
    expect(syncRoute).toContain("if (direction === 'push' || direction === 'merge')");
    expect(syncRoute).not.toContain('whitelistEntry.deleteMany');
    expect(syncRoute).not.toContain('enqueueWhitelistRemove(');
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
    expect(serverBan).toContain("remoteSequence: 'BAN_THEN_WHITELIST_REMOVE'");
  });

  it('keeps SERVER_BAN_ADD as exact ban-confirm then exact whitelist-remove path', () => {
    const banStart = worker.indexOf("case 'SERVER_BAN_ADD':");
    const verifyIdentity = worker.indexOf('matchesBanIdentifier(sensitiveIdentifier, ban.identityHash, config.security.encryptionKey)', banStart);
    const banlistRead = worker.indexOf('const before = await client.getBanlist(conn.nitradoServerId);', verifyIdentity);
    const banlistAdd = worker.indexOf('await client.addToBanlist(conn.nitradoServerId, sensitiveIdentifier);', banlistRead);
    const whitelistRemove = worker.indexOf('await client.removeFromWhitelist(conn.nitradoServerId, sensitiveIdentifier);', banlistAdd);
    const applied = worker.indexOf('data: { appliedRemotely: true }', whitelistRemove);

    expect(banStart).toBeGreaterThanOrEqual(0);
    expect(verifyIdentity).toBeGreaterThan(banStart);
    expect(banlistRead).toBeGreaterThan(verifyIdentity);
    expect(banlistAdd).toBeGreaterThan(banlistRead);
    expect(whitelistRemove).toBeGreaterThan(banlistAdd);
    expect(applied).toBeGreaterThan(whitelistRemove);
  });
});
