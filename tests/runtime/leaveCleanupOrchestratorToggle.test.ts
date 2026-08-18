import fs from 'node:fs';
import path from 'node:path';

const read = (relative: string) => fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8');

const eventSource = read('src/events/guildMemberRemove.ts');
const readySource = read('src/events/ready.ts');
const workerSource = read('src/modules/moderation/leaveCleanupWorker.ts');
const configSource = read('src/modules/moderation/leaveCleanupConfig.ts');
const guardSource = read('src/modules/moderation/leaveCleanupGuard.ts');
const routeSource = read('src/dashboard/routes/v2/leaveCleanup.ts');
const v2Source = read('src/dashboard/routes/v2.ts');
const panelSource = read('dashboard-ui/src/components/LeaveCleanupPanel.tsx');
const welcomeSource = read('dashboard-ui/src/components/WelcomeTab.tsx');
const linkSource = read('src/modules/linking/linkService.ts');
const rewardSource = read('src/modules/linking/linkRewards.ts');

describe('Leave-1E productive orchestration + toggle wiring', () => {
  it('uses a guild-scoped BotConfig key and defaults destructive behavior to OFF', () => {
    expect(configSource).toContain("deletePlayerDataOnLeave: false");
    expect(configSource).toContain('`leave-cleanup:${guildId}`');
    expect(configSource).not.toContain("feature.");
  });

  it('requires the real guild owner and rejects malformed config bodies before persistence', () => {
    expect(routeSource).toContain("leaveCleanupRouter.get('/config', requireGuildOwner");
    expect(routeSource).toContain("leaveCleanupRouter.post('/config', requireGuildOwner");
    expect(routeSource).toContain("if (!body || typeof body !== 'object' || Array.isArray(body)) return null;");
    expect(routeSource).toContain("if (typeof value !== 'boolean') return null;");
    expect(routeSource).toContain('const parsed = parseBody(req.body);');
    expect(v2Source).toContain("v2Router.use('/guilds/:guildId/leave-cleanup', leaveCleanupRouter);");
  });

  it('makes OFF a true no-delete path and ON only a durable enqueue in guildMemberRemove', () => {
    const configAt = eventSource.indexOf('await getLeaveCleanupConfig(');
    const enabledAt = eventSource.indexOf('if (leaveCfg.deletePlayerDataOnLeave)');
    const enqueueAt = eventSource.indexOf('await enqueueLeaveCleanupRequest(');
    expect(configAt).toBeGreaterThanOrEqual(0);
    expect(enabledAt).toBeGreaterThan(configAt);
    expect(enqueueAt).toBeGreaterThan(enabledAt);
    expect(eventSource).not.toContain('cleanupGuildMemberData');
    expect(eventSource).not.toContain('runLeaveWhitelistCleanupStep');
  });

  it('starts stale recovery/worker from Ready and stops it symmetrically', () => {
    expect(readySource).toContain('await startLeaveCleanupWorker();');
    expect(readySource).toContain('stopLeaveCleanupWorker();');
    expect(workerSource).toContain('recoverStaleLeaveCleanupRequests');
    expect(workerSource).toContain('timer.unref?.();');
  });

  it('orders every destructive worker step before the pseudonymous completion receipt', () => {
    const whitelist = workerSource.indexOf('await runLeaveWhitelistCleanupStep(');
    const stats = workerSource.indexOf('await runLeaveStatsSessionsCleanupStep(');
    const economy = workerSource.indexOf('await runLeaveLinkEconomyAfterConfirmedWhitelistStep(');
    const guildData = workerSource.indexOf('await cleanupGuildMemberData(');
    const complete = workerSource.indexOf('await completeLeaveCleanupRequest(');
    expect(whitelist).toBeGreaterThanOrEqual(0);
    expect(stats).toBeGreaterThan(whitelist);
    expect(economy).toBeGreaterThan(stats);
    expect(guildData).toBeGreaterThan(economy);
    expect(complete).toBeGreaterThan(guildData);
  });

  it('blocks normal and force relinking centrally while cleanup is active or dead-lettered', () => {
    expect(guardSource).toContain("status: { in: ['PENDING', 'IN_PROGRESS', 'FAILED'] }");
    const normal = linkSource.indexOf('export async function linkByPlayerName');
    const force = linkSource.indexOf('export async function forceLinkByPlayerName');
    expect(linkSource.indexOf('assertNoOpenLeaveCleanupRequest', normal)).toBeGreaterThan(normal);
    expect(linkSource.indexOf('assertNoOpenLeaveCleanupRequest', force)).toBeGreaterThan(force);
    expect(rewardSource).toContain('hasOpenLeaveCleanupRequest(scope.guildId, userDiscordId)');
    expect(rewardSource).toContain('assertNoOpenLeaveCleanupRequest(scope.guildId, userDiscordId)');
  });

  it('renders the destructive toggle owner-only and mobile-responsive in the member lifecycle area', () => {
    expect(panelSource).toContain("const isOwner = ownerQ.data?.isOwner === true;");
    expect(panelSource).toContain('if (!isOwner) return null;');
    expect(panelSource).toContain('enabled: !!guildId && isOwner');
    expect(panelSource).toContain('confirm(');
    expect(panelSource).toContain('grid-cols-1 sm:grid-cols-2');
    expect(panelSource).toContain('w-full sm:w-auto');
    expect(welcomeSource).toContain('<LeaveCleanupPanel guildId={props.guildId} />');
  });
});
