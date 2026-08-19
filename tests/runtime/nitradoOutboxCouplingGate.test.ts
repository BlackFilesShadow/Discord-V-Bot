import fs from 'node:fs';
import path from 'node:path';

const read = (relative: string) => fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8');

const outboxLock = read('src/modules/nitrado/outboxLock.ts');
const rebindLifecycle = read('src/modules/nitrado/rebindOutboxLifecycle.ts');
const whitelistOutbox = read('src/modules/whitelist/whitelistOutbox.ts');
const banOutbox = read('src/modules/bans/banOutbox.ts');
const dashboardWhitelist = read('src/dashboard/routes/v2/whitelist.ts');
const slashWhitelist = read('src/commands/dashboard/whitelist.ts');
const approvalButton = read('src/modules/whitelist/whitelistApprovalButton.ts');
const syncCron = read('src/modules/whitelist/whitelistSyncCron.ts');
const leaveWhitelist = read('src/modules/moderation/leaveCleanupWhitelist.ts');
const nitradoRoute = read('src/dashboard/routes/v2/nitrado.ts');
const nitradoRepository = read('src/modules/nitrado/repository.ts');
const jobWorker = read('src/modules/nitrado/jobWorker.ts');

describe('Nitrado-1A/1U outbox + token/service coupling architecture gate', () => {
  it('uses hashed PostgreSQL transaction advisory locks for subject and connection boundaries', () => {
    expect(outboxLock).toContain("createHash('sha256')");
    expect(outboxLock).toContain("'SELECT pg_advisory_xact_lock($1, $2)'");
    expect(outboxLock).toContain("'$transaction' in client");
    expect(outboxLock).toContain('export async function withNitradoOutboxConnectionLock');
    expect(outboxLock).toContain("'nitrado-outbox-connection:v1'");
    expect(outboxLock).toContain('return client.$transaction(tx => lockedInTransaction(tx, subject, work));');
    expect(outboxLock).toContain('return client.$transaction(tx => lockedInTransaction(tx, subjectKey, work));');
  });

  it('centralizes whitelist ADD/REMOVE under connection barrier then subject lock without active-job scan cap', () => {
    const helper = whitelistOutbox.indexOf('async function ensureWhitelistJobInLock(');
    const create = whitelistOutbox.indexOf('await tx.nitradoJob.create({', helper);
    const connectionLock = whitelistOutbox.indexOf('withNitradoOutboxConnectionLock(client, scope, tx =>');
    const subjectLock = whitelistOutbox.indexOf('withNitradoOutboxSubjectLock(tx, lockSubject', connectionLock);
    const ensureCall = whitelistOutbox.indexOf(
      'ensureWhitelistJobInLock(lockedTx, scope, operation, gameId, normalizedGameId)',
      subjectLock,
    );
    expect(helper).toBeGreaterThanOrEqual(0);
    expect(create).toBeGreaterThan(helper);
    expect(connectionLock).toBeGreaterThanOrEqual(0);
    expect(subjectLock).toBeGreaterThan(connectionLock);
    expect(ensureCall).toBeGreaterThan(subjectLock);
    expect(whitelistOutbox).toContain("status: { in: ['PENDING', 'RUNNING'] }");
    expect(whitelistOutbox).toContain("return enqueueWhitelistJob(client, scope, 'WHITELIST_ADD', gameId);");
    expect(whitelistOutbox).toContain("return enqueueWhitelistJob(client, scope, 'WHITELIST_REMOVE', gameId);");
    expect(whitelistOutbox).not.toContain('take: 500');
  });

  it('forbids direct whitelist NitradoJob.create calls from productive writers outside helper', () => {
    const writers = [dashboardWhitelist, slashWhitelist, approvalButton, syncCron, leaveWhitelist];
    for (const source of writers) {
      expect(source).not.toContain('nitradoJob.create({');
    }
    expect(dashboardWhitelist).toContain('enqueueWhitelistAdd(');
    expect(dashboardWhitelist).toContain('enqueueWhitelistRemove(');
    expect(slashWhitelist).toContain('enqueueWhitelistAdd(');
    expect(slashWhitelist).toContain('enqueueWhitelistRemove(');
    expect(approvalButton).toContain('enqueueWhitelistAdd(');
    expect(syncCron).toContain('enqueueWhitelistAdd(');
    expect(syncCron).toContain('enqueueWhitelistRemove(');
    expect(leaveWhitelist).toContain('enqueueWhitelistRemove(');
  });

  it('keeps local whitelist lifecycle writes and outbox enqueue in same Prisma transaction', () => {
    const postTx = dashboardWhitelist.indexOf('await prisma.$transaction(async tx => {');
    const postEntry = dashboardWhitelist.indexOf('await tx.whitelistEntry.create({', postTx);
    const postOutbox = dashboardWhitelist.indexOf('await enqueueWhitelistAdd(', postEntry);
    expect(postTx).toBeGreaterThanOrEqual(0);
    expect(postEntry).toBeGreaterThan(postTx);
    expect(postOutbox).toBeGreaterThan(postEntry);

    const removeTx = slashWhitelist.indexOf('await prisma.$transaction(async tx => {', slashWhitelist.indexOf('export const wlRemoveCommand'));
    const pendingRemove = slashWhitelist.indexOf("syncState: 'PENDING_REMOVE'", removeTx);
    const removeOutbox = slashWhitelist.indexOf('await enqueueWhitelistRemove(', pendingRemove);
    expect(removeTx).toBeGreaterThanOrEqual(0);
    expect(pendingRemove).toBeGreaterThan(removeTx);
    expect(removeOutbox).toBeGreaterThan(pendingRemove);
  });

  it('keeps server-ban ADD/REMOVE dedupe under connection barrier then subject lock', () => {
    const connectionLock = banOutbox.indexOf('withNitradoOutboxConnectionLock(client, scope, tx =>');
    const subjectLock = banOutbox.indexOf('withNitradoOutboxSubjectLock(tx, lockSubject', connectionLock);
    expect(connectionLock).toBeGreaterThanOrEqual(0);
    expect(subjectLock).toBeGreaterThan(connectionLock);
    expect(banOutbox).toContain("status: { in: ['PENDING', 'RUNNING'] }");
    expect(banOutbox).toContain("'SERVER_BAN_ADD'");
    expect(banOutbox).toContain("'SERVER_BAN_REMOVE'");
    expect(banOutbox).not.toContain('take: 500');
  });

  it('fails token rotation closed when existing service cannot be verified against new token', () => {
    const rotation = nitradoRoute.indexOf("nitradoRouter.patch('/:slot/token'");
    const serviceRead = nitradoRoute.indexOf('services = await client.listServices();', rotation);
    const failureResponse = nitradoRoute.indexOf("res.status(502).json({", serviceRead);
    const returnAt = nitradoRoute.indexOf('return;', failureResponse);
    const tokenWrite = nitradoRoute.indexOf('updated = await updateToken(', rotation);

    expect(rotation).toBeGreaterThanOrEqual(0);
    expect(serviceRead).toBeGreaterThan(rotation);
    expect(failureResponse).toBeGreaterThan(serviceRead);
    expect(returnAt).toBeGreaterThan(failureResponse);
    expect(tokenWrite).toBeGreaterThan(returnAt);
    expect(nitradoRoute).toContain('Token wurde nicht geändert: Die vorhandene Nitrado-Service-Zuordnung konnte mit dem neuen Token nicht verifiziert werden.');
  });

  it('persists proven token/service mismatch atomically and clears both service mirrors', () => {
    const updateToken = nitradoRepository.indexOf('export async function updateToken(');
    const transaction = nitradoRepository.indexOf('await prisma.$transaction(async tx => {', updateToken);
    const rebindFence = nitradoRepository.indexOf('prepareNitradoRemoteStateForServiceRebind(', transaction);
    const tokenUpdate = nitradoRepository.indexOf('await tx.nitradoConnection.updateMany({', rebindFence);
    const serviceResetA = nitradoRepository.indexOf('nitradoServerId: null', tokenUpdate);
    const serviceResetB = nitradoRepository.indexOf('serviceId: null', serviceResetA);
    const healthReset = nitradoRepository.indexOf('await tx.nitradoValidationHealth.updateMany({', tokenUpdate);

    expect(updateToken).toBeGreaterThanOrEqual(0);
    expect(transaction).toBeGreaterThan(updateToken);
    expect(rebindFence).toBeGreaterThan(transaction);
    expect(tokenUpdate).toBeGreaterThan(rebindFence);
    expect(serviceResetA).toBeGreaterThan(tokenUpdate);
    expect(serviceResetB).toBeGreaterThan(serviceResetA);
    expect(healthReset).toBeGreaterThan(tokenUpdate);
    expect(nitradoRoute).not.toContain('if (serviceMismatch) {\n    await updateServiceId');
  });

  it('makes actual service change pass remote-state lifecycle before connection/binding mutation', () => {
    const updateService = nitradoRepository.indexOf('export async function updateServiceId(');
    const before = nitradoRepository.indexOf('const before = await tx.nitradoConnection.findFirst({', updateService);
    const changed = nitradoRepository.indexOf('if (before.nitradoServerId !== nitradoServerId) {', before);
    const lifecycle = nitradoRepository.indexOf('prepareNitradoRemoteStateForServiceRebind(', changed);
    const busy = nitradoRepository.indexOf('if (lifecycle.busy) throw new NitradoConnectionBusyError();', lifecycle);
    const connectionWrite = nitradoRepository.indexOf('await tx.nitradoConnection.updateMany({', busy);
    expect(updateService).toBeGreaterThanOrEqual(0);
    expect(before).toBeGreaterThan(updateService);
    expect(changed).toBeGreaterThan(before);
    expect(lifecycle).toBeGreaterThan(changed);
    expect(busy).toBeGreaterThan(lifecycle);
    expect(connectionWrite).toBeGreaterThan(busy);
  });

  it('rebind lifecycle serializes enqueue, blocks RUNNING mutations, cancels stale remove intents and resets observations', () => {
    expect(rebindLifecycle).toContain('withNitradoOutboxConnectionLock(client, scope');
    expect(rebindLifecycle).toContain("status: 'RUNNING'");
    expect(rebindLifecycle).toContain("'WHITELIST_ADD'");
    expect(rebindLifecycle).toContain("'WHITELIST_REMOVE'");
    expect(rebindLifecycle).toContain("'SERVER_BAN_ADD'");
    expect(rebindLifecycle).toContain("'SERVER_BAN_REMOVE'");
    expect(rebindLifecycle).toContain("operation: { in: [...CANCEL_ON_REBIND_OPERATIONS] }");
    expect(rebindLifecycle).toContain("syncState: 'LOCAL_ONLY'");
    expect(rebindLifecycle).toContain('appliedRemotely: false');
    expect(rebindLifecycle).toContain('const racedRunning = await lockedTx.nitradoJob.findFirst({');
  });

  it('version-fences token and service writes to exact remotely validated connection id + updatedAt snapshot', () => {
    expect(nitradoRepository).toContain('updatedAt: Date;');
    expect(nitradoRepository).toContain('export class NitradoSlotVersionConflictError extends Error');
    expect(nitradoRepository).toContain('expectedId?: NitradoConnId;');
    expect(nitradoRepository).toContain('expectedUpdatedAt?: Date;');
    expect(nitradoRepository).toContain("if (options.expectedId && current.id !== options.expectedId)");
    expect(nitradoRepository).toContain('const targetId = options.expectedId ?? asNitradoConnId(current.id);');
    expect(nitradoRepository).toContain('id: targetId');
    expect(nitradoRepository).toContain("...(options.expectedUpdatedAt ? { updatedAt: options.expectedUpdatedAt } : {})");
    expect(nitradoRepository).toContain('throw new NitradoSlotVersionConflictError();');
    expect(nitradoRepository).toContain('where: { id: targetId, guildId, slot }');

    expect(nitradoRoute).toContain('expectedId: existing.id');
    expect(nitradoRoute).toContain('expectedUpdatedAt: existing.updatedAt');
    expect(nitradoRoute).toContain("code: 'NITRADO_SLOT_VERSION_CONFLICT'");
    expect(nitradoRoute).toContain('updated = await updateToken(scope.guildId, slot, token, {');
    expect(nitradoRoute).toContain('updated = await updateServiceId(scope.guildId, slot, normalized, {');
  });

  it('keeps raw remote whitelist/ban mutators only in serialized Nitrado job worker', () => {
    expect(jobWorker).toContain('await client.addToWhitelist(conn.nitradoServerId, payload.gameId);');
    expect(jobWorker).toContain('await client.removeFromWhitelist(conn.nitradoServerId, payload.gameId);');
    expect(jobWorker).toContain('await client.addToBanlist(conn.nitradoServerId, sensitiveIdentifier);');
    expect(jobWorker).toContain('await client.removeFromBanlist(conn.nitradoServerId, sensitiveIdentifier);');
    expect(jobWorker).toContain('connectionLock = await tryAcquireConnectionLock(job.nitradoConnId);');
    expect(jobWorker).toContain('await connectionLock.release();');
  });
});
