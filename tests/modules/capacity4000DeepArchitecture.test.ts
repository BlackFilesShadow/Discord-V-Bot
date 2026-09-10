import fs from 'node:fs';
import path from 'node:path';

const read = (relative: string): string => fs.readFileSync(path.join(process.cwd(), relative), 'utf8');

describe('4,000-player deep capacity guards', () => {
  it('whitelist dashboard exposes keyset pagination instead of an inaccessible hard cap', () => {
    const route = read('src/dashboard/routes/v2/whitelist.ts');
    const ui = read('dashboard-ui/src/pages/ServerSlot.tsx');
    const getRoute = route.split("whitelistRouter.get('/'")[1].split("whitelistRouter.post('/'")[0];
    expect(getRoute).toContain('nextCursor');
    expect(getRoute).toContain('approvedAt: { lt: cursor.approvedAt }');
    expect(getRoute).toContain('gameId: { gt: cursor.gameId }');
    expect(ui).toContain('useInfiniteQuery');
    expect(ui).toContain('Weitere Eintraege laden');
  });

  it('goodbye identity evidence and whitelist leave safety are not capped by global population prefixes', () => {
    const goodbye = read('src/modules/welcome/goodbyeStatus.ts');
    const leave = read('src/modules/moderation/leaveCleanupWhitelist.ts');
    const intent = read('src/modules/nitrado/whitelistIntent.ts');
    const goodbyeSection = goodbye.split('initialGoodbyeCleanupSnapshot')[1].split('editPersistedGoodbye')[0];
    const jobsSection = leave.split('async function listWhitelistJobs')[1].split('async function processLink')[0];
    const intentSection = intent.split('const leaveRequests =')[1].split('const activeDiscordIds')[0];

    expect(goodbyeSection).toContain('collectIdentityPlayerNames');
    expect(goodbyeSection).not.toContain('take: 5000');
    expect(jobsSection).not.toContain('take: 1000');
    expect(intentSection).not.toContain('take: 500');
  });
});
