import fs from 'node:fs';
import path from 'node:path';

const read = (relative: string) => fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8');

const addSource = read('src/events/guildMemberAdd.ts');
const removeSource = read('src/events/guildMemberRemove.ts');
const workerSource = read('src/modules/moderation/leaveCleanupWorker.ts');
const sagaSource = read('src/modules/moderation/leaveCleanupSaga.ts');
const leaseSource = read('src/modules/moderation/leaveCleanupLease.ts');
const rejoinSource = read('src/modules/moderation/leaveCleanupRejoin.ts');
const awarenessSource = read('src/modules/ai/memberAwareness.ts');
const messageSource = read('src/events/messageCreate.ts');
const voiceSource = read('src/events/voiceStateUpdate.ts');
const xpManagerSource = read('src/modules/xp/xpManager.ts');
const rewardSource = read('src/modules/linking/linkRewards.ts');
const economySource = read('src/modules/economy/repository.ts');

describe('Leave-1G rejoin fresh-state architecture gate', () => {
  it('records current rejoin recognition before checking the cleanup barrier and defers LevelData while the barrier is open', () => {
    const syncAt = addSource.indexOf('await syncMemberProfile(m);');
    const guardAt = addSource.indexOf('await hasOpenLeaveCleanupRequest(m.guild.id, m.user.id);');
    const levelAt = addSource.indexOf('await prisma.levelData.upsert({');

    expect(syncAt).toBeGreaterThanOrEqual(0);
    expect(guardAt).toBeGreaterThan(syncAt);
    expect(levelAt).toBeGreaterThan(guardAt);
    expect(addSource).toContain('let leaveCleanupOpen = true;');
    expect(addSource).toContain('if (!leaveCleanupOpen) {');
  });

  it('keeps the early leave barrier and reconfirms it after markMemberLeft before goodbye', () => {
    const firstEnqueue = removeSource.indexOf('await enqueueLeaveCleanupRequest({');
    const markLeft = removeSource.indexOf('await markMemberLeft(m.guild.id, m.user.id);');
    const secondEnqueue = removeSource.indexOf('await enqueueLeaveCleanupRequest({', firstEnqueue + 1);
    const goodbye = removeSource.indexOf('await sendConfiguredGoodbye(m);');

    expect(firstEnqueue).toBeGreaterThanOrEqual(0);
    expect(markLeft).toBeGreaterThan(firstEnqueue);
    expect(secondEnqueue).toBeGreaterThan(markLeft);
    expect(goodbye).toBeGreaterThan(secondEnqueue);
  });

  it('keeps #104 periodic failover recovery and checkpoint lease renewal in the combined worker/saga', () => {
    expect(workerSource).toContain('const RECOVERY_INTERVAL_MS = 60_000;');
    expect(workerSource).toContain('async function recoverStaleIfDue');
    const recoveryAt = workerSource.indexOf('await recoverStaleIfDue();');
    const pollAt = workerSource.indexOf('const request = await claimNextLeaveCleanupRequest();');
    expect(recoveryAt).toBeGreaterThanOrEqual(0);
    expect(pollAt).toBeGreaterThan(recoveryAt);

    expect(sagaSource).toContain('function recoveryClaimFence(details: LeaveCleanupDetails)');
    expect(sagaSource).toContain("{ details: { path: ['claimToken'], equals: details.claimToken } }");
    expect(sagaSource).toContain("{ details: { path: ['claimedAt'], equals: details.claimedAt } }");
    expect(sagaSource).toContain('claimedAt: now.toISOString()');
  });

  it('heartbeats every potentially long destructive substep well inside the stale-recovery window', () => {
    expect(workerSource).toContain('const LEASE_HEARTBEAT_INTERVAL_MS = 60_000;');
    expect(workerSource).toContain('async function runWithLeaseHeartbeat');
    expect(workerSource).toContain('currentRequest = await renewLeaveCleanupClaimLease(initialRequest, guildId, discordId);');
    expect(workerSource).toContain('currentRequest = await renewLeaveCleanupClaimLease(currentRequest, guildId, discordId);');
    expect(workerSource).toContain('() => runLeaveWhitelistCleanupStep(guildId, discordId)');
    expect(workerSource).toContain('() => runLeaveStatsSessionsCleanupStep(guildId, discordId)');
    expect(workerSource).toContain('() => runLeaveLinkEconomyAfterConfirmedWhitelistStep(guildId, discordId)');
    expect(workerSource).toContain('() => cleanupGuildMemberData(guildId, discordId)');
    expect(workerSource).toContain('request = await renewLeaveCleanupClaimLease(request, guildId, discordId);');

    expect(leaseSource).toContain("jsonb_extract_path_text(\"details\", 'claimToken')=$4");
    expect(leaseSource).toContain("jsonb_extract_path_text(\"details\", 'claimedAt')=$5");
    expect(leaseSource).toContain("jsonb_extract_path_text(\"details\", 'claimedAt')=$4");
    expect(leaseSource).toContain('const nextMs = Math.max(now.getTime(), oldMs + 1);');
    expect(leaseSource).toContain("throw new Error('Leave-Cleanup Lease-CAS verloren.')");
  });

  it('finalizes the full fenced request after GUILD_DATA and rechecks it immediately before the completion receipt', () => {
    const guildCleanup = workerSource.indexOf('() => cleanupGuildMemberData(guildId, discordId)');
    const firstFinalize = workerSource.indexOf('await finalizeLeaveRejoinState(request, guildId, discordId);', guildCleanup);
    const advance = workerSource.indexOf("await advanceLeaveCleanupStep(request, 'GUILD_DATA');", firstFinalize);
    const completeBranch = workerSource.indexOf("if (details.step === 'COMPLETE')");
    const secondFinalize = workerSource.indexOf('await finalizeLeaveRejoinState(request, guildId, discordId);', completeBranch);
    const receipt = workerSource.indexOf('await completeLeaveCleanupRequest(', secondFinalize);

    expect(guildCleanup).toBeGreaterThanOrEqual(0);
    expect(firstFinalize).toBeGreaterThan(guildCleanup);
    expect(advance).toBeGreaterThan(firstFinalize);
    expect(secondFinalize).toBeGreaterThan(completeBranch);
    expect(receipt).toBeGreaterThan(secondFinalize);
  });

  it('fences modern rejoin mutation by claimToken plus exact renewed claimedAt and keeps legacy claimedAt support', () => {
    expect(rejoinSource).toContain('readLeaveCleanupDetails(claimedRequest.details)');
    expect(rejoinSource).toContain('const claimedAt = expectedDetails.claimedAt;');
    expect(rejoinSource).toContain('const claimToken = expectedDetails.claimToken ?? null;');
    expect(rejoinSource).toContain("jsonb_extract_path_text(\"details\", 'claimToken')=$4");
    expect(rejoinSource).toContain("jsonb_extract_path_text(\"details\", 'claimedAt')=$5");
    expect(rejoinSource).toContain("jsonb_extract_path_text(\"details\", 'claimedAt')=$4");
    expect(rejoinSource).toContain('FOR UPDATE');
    expect(rejoinSource).toContain("AND \"status\"='IN_PROGRESS'");
  });

  it('uses request.createdAt plus current GuildMemberProfile state as the rejoin lifecycle boundary', () => {
    expect(rejoinSource).toContain('SELECT "createdAt"');
    expect(rejoinSource).toContain('profile.isLeft === false');
    expect(rejoinSource).toContain('profile.joinedAt.getTime() > request.createdAt.getTime()');
    expect(rejoinSource).toContain('joinedAt: { gt: request.createdAt }');
    expect(rejoinSource).toContain('messageCount: 0');
  });

  it('preserves goodbye identity and CAS-fences stale profile normalization against a concurrent real rejoin', () => {
    expect(rejoinSource).toContain('await tx.xpRecord.deleteMany({ where: { userId: user.id, guildId } });');
    expect(rejoinSource).toContain('await tx.levelData.deleteMany({ where: { userId: user.id, guildId } });');
    expect(rejoinSource).not.toContain('guildMemberProfile.deleteMany');
    expect(rejoinSource).toContain('isLeft: profile.isLeft');
    expect(rejoinSource).toContain('joinedAt: profile.joinedAt');
    expect(rejoinSource).toContain('leftAt: profile.leftAt');
    expect(rejoinSource).toContain("throw new Error('Leave-Rejoin-Finalizer: Profil-CAS verloren.')");
    expect(rejoinSource).toContain('leftAt: profile.leftAt ?? request.createdAt');
    expect(rejoinSource).toContain('await tx.levelData.upsert({');
    expect(rejoinSource).toContain('create: { userId: user.id, guildId }');
    expect(rejoinSource).toContain('update: {}');
  });

  it('allows activity writes only against an already active profile and never creates or revives lifecycle state', () => {
    const activityStart = awarenessSource.indexOf('export async function trackMemberActivity');
    const activityEnd = awarenessSource.indexOf('export async function syncMemberProfile', activityStart);
    const activityFunction = awarenessSource.slice(activityStart, activityEnd);

    expect(activityStart).toBeGreaterThanOrEqual(0);
    expect(activityFunction).toContain('await prisma.guildMemberProfile.updateMany({');
    expect(activityFunction).toContain('isLeft: false');
    expect(activityFunction).not.toContain('guildMemberProfile.upsert');
    expect(activityFunction).not.toContain('leftAt: null');
    expect(activityFunction).not.toContain('joinedAt: member.joinedAt');
    expect(awarenessSource).toContain('data: { isLeft: true, leftAt: new Date(), lastSeenAt: new Date() }');
  });

  it('blocks direct Message-XP before User/Level/Record mutations while a leave cleanup is open', () => {
    const section = messageSource.indexOf('// ===== SEKTION 8: XP-VERGABE');
    const guardAt = messageSource.indexOf('await hasOpenLeaveCleanupRequest(msg.guildId, msg.author.id)', section);
    const userAt = messageSource.indexOf('const user = await prisma.user.upsert({', section);
    const levelAt = messageSource.indexOf('const updated = await prisma.levelData.upsert({', section);
    const recordAt = messageSource.indexOf('await prisma.xpRecord.create({', section);

    expect(section).toBeGreaterThanOrEqual(0);
    expect(guardAt).toBeGreaterThan(section);
    expect(userAt).toBeGreaterThan(guardAt);
    expect(levelAt).toBeGreaterThan(userAt);
    expect(recordAt).toBeGreaterThan(levelAt);
  });

  it('blocks direct Voice-XP before User/Level/Record mutations while a leave cleanup is open', () => {
    const guardAt = voiceSource.indexOf('await hasOpenLeaveCleanupRequest(guildId, userId)');
    const userAt = voiceSource.indexOf('const dbUser = await prisma.user.upsert({');
    const levelAt = voiceSource.indexOf('const levelData = await prisma.levelData.upsert({');
    const recordAt = voiceSource.indexOf('await prisma.xpRecord.create({');

    expect(guardAt).toBeGreaterThanOrEqual(0);
    expect(userAt).toBeGreaterThan(guardAt);
    expect(levelAt).toBeGreaterThan(userAt);
    expect(recordAt).toBeGreaterThan(levelAt);
  });

  it('fences every user-specific XP manager write including reset before its first mutation', () => {
    const helper = xpManagerSource.indexOf('async function assertXpSubjectWritable');
    const helperGuard = xpManagerSource.indexOf('await assertNoOpenLeaveCleanupRequest(guildId, user.discordId);', helper);
    const grantStart = xpManagerSource.indexOf('export async function grantEventXp');
    const grantGuard = xpManagerSource.indexOf("await assertXpSubjectWritable(userId, guildId, 'Event-XP');", grantStart);
    const grantLevel = xpManagerSource.indexOf('const updated = await prisma.levelData.upsert({', grantStart);
    const resetStart = xpManagerSource.indexOf('export async function resetUserXp');
    const resetGuard = xpManagerSource.indexOf("await assertXpSubjectWritable(userId, guildId, 'XP-Reset');", resetStart);
    const resetLevel = xpManagerSource.indexOf('const levelData = await prisma.levelData.findUnique({', resetStart);
    const resetRecord = xpManagerSource.indexOf('await prisma.xpRecord.create({', resetStart);

    expect(helper).toBeGreaterThanOrEqual(0);
    expect(helperGuard).toBeGreaterThan(helper);
    expect(grantGuard).toBeGreaterThan(grantStart);
    expect(grantLevel).toBeGreaterThan(grantGuard);
    expect(resetGuard).toBeGreaterThan(resetStart);
    expect(resetLevel).toBeGreaterThan(resetGuard);
    expect(resetRecord).toBeGreaterThan(resetLevel);
  });

  it('keeps anti-churn start balance protection in both modern and legacy award paths', () => {
    expect(rewardSource).toContain('hasCompletedLeaveCleanupReceipt(');
    expect(economySource).toContain('hasCompletedLeaveCleanupReceipt(');
    expect(rewardSource).toContain('hasOpenLeaveCleanupRequest(scope.guildId, userDiscordId)');
  });
});
