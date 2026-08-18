import fs from 'node:fs';
import path from 'node:path';

const read = (relative: string) => fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8');

const addSource = read('src/events/guildMemberAdd.ts');
const removeSource = read('src/events/guildMemberRemove.ts');
const workerSource = read('src/modules/moderation/leaveCleanupWorker.ts');
const rejoinSource = read('src/modules/moderation/leaveCleanupRejoin.ts');
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

  it('finalizes rejoin state after GUILD_DATA and rechecks it immediately before the completion receipt', () => {
    const guildCleanup = workerSource.indexOf('await cleanupGuildMemberData(guildId, discordId);');
    const firstFinalize = workerSource.indexOf('await finalizeLeaveRejoinState(request.id, guildId, discordId);', guildCleanup);
    const advance = workerSource.indexOf("await advanceLeaveCleanupStep(request, 'GUILD_DATA');", firstFinalize);
    const completeBranch = workerSource.indexOf("if (details.step === 'COMPLETE')");
    const secondFinalize = workerSource.indexOf('await finalizeLeaveRejoinState(request.id, guildId, discordId);', completeBranch);
    const receipt = workerSource.indexOf('await completeLeaveCleanupRequest(', secondFinalize);

    expect(guildCleanup).toBeGreaterThanOrEqual(0);
    expect(firstFinalize).toBeGreaterThan(guildCleanup);
    expect(advance).toBeGreaterThan(firstFinalize);
    expect(secondFinalize).toBeGreaterThan(completeBranch);
    expect(receipt).toBeGreaterThan(secondFinalize);
  });

  it('uses request.createdAt plus current GuildMemberProfile state as the rejoin lifecycle boundary', () => {
    expect(rejoinSource).toContain("status: 'IN_PROGRESS'");
    expect(rejoinSource).toContain('select: { createdAt: true }');
    expect(rejoinSource).toContain('profile.isLeft === false');
    expect(rejoinSource).toContain('profile.joinedAt.getTime() > request.createdAt.getTime()');
    expect(rejoinSource).toContain('joinedAt: { gt: request.createdAt }');
    expect(rejoinSource).toContain('messageCount: 0');
  });

  it('removes late residual Level/XP state without rejoin but creates only a zero-default baseline for a genuine rejoin', () => {
    expect(rejoinSource).toContain('await tx.xpRecord.deleteMany({ where: { userId: user.id, guildId } });');
    expect(rejoinSource).toContain('await tx.levelData.deleteMany({ where: { userId: user.id, guildId } });');
    expect(rejoinSource).toContain("profile: deletedProfile.count > 0 ? 'DELETED' : 'NONE'");
    expect(rejoinSource).toContain('await tx.levelData.upsert({');
    expect(rejoinSource).toContain('create: { userId: user.id, guildId }');
    expect(rejoinSource).toContain('update: {}');
  });

  it('keeps anti-churn start balance protection in both modern and legacy award paths', () => {
    expect(rewardSource).toContain('hasCompletedLeaveCleanupReceipt(');
    expect(economySource).toContain('hasCompletedLeaveCleanupReceipt(');
    expect(rewardSource).toContain('hasOpenLeaveCleanupRequest(scope.guildId, userDiscordId)');
  });
});
