import fs from 'node:fs';
import path from 'node:path';
import { normalizeSourceNewlines } from '../helpers/sourceText';

const read = (relative: string) => normalizeSourceNewlines(
  fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8'),
);

const welcomeRoute = read('src/dashboard/routes/v2/welcome.ts');
const goodbyeRoute = read('src/dashboard/routes/v2/goodbye.ts');
const welcomeManager = read('src/modules/welcome/welcomeManager.ts');
const memberAdd = read('src/events/guildMemberAdd.ts');
const leaveWhitelist = read('src/modules/moderation/leaveCleanupWhitelist.ts');
const whitelistIntent = read('src/modules/nitrado/whitelistIntent.ts');
const whitelistOutbox = read('src/modules/whitelist/whitelistOutbox.ts');

describe('Welcome/Goodbye/Leave-Cleanup reliability regressions', () => {
  it('resolves local welcome uploads from the configured upload root with a path boundary', () => {
    expect(welcomeManager).toContain("const base = path.resolve(config.upload.dir);");
    expect(welcomeManager).toContain("const relative = mediaUrl.replace(/^\\/uploads\\//, '');");
    expect(welcomeManager).toContain("!resolved.startsWith(base + path.sep)");
    expect(welcomeManager).not.toContain("path.join(process.cwd(), mediaUrl.replace");
  });

  it('fetches the configured welcome channel instead of relying on cache presence', () => {
    expect(memberAdd).toContain('await m.guild.channels.fetch(wcfg.channelId)');
    expect(memberAdd).not.toContain('m.guild.channels.cache.get(wcfg.channelId)');
  });

  it('keeps active media until config persistence and deletes only the previous active file', () => {
    const uploadStart = welcomeRoute.indexOf("welcomeRouter.post(\n  '/media'");
    const deleteStart = welcomeRoute.indexOf("welcomeRouter.delete('/media'");
    const uploadBlock = welcomeRoute.slice(uploadStart, deleteStart);
    expect(uploadStart).toBeGreaterThanOrEqual(0);
    expect(uploadBlock).toContain('await fs.writeFile');
    expect(uploadBlock).not.toContain('fs.unlink');
    expect(uploadBlock).not.toContain('fs.readdir');

    const saveStart = welcomeRoute.indexOf("welcomeRouter.post('/config'");
    const disableStart = welcomeRoute.indexOf("welcomeRouter.post('/disable'");
    const saveBlock = welcomeRoute.slice(saveStart, disableStart);
    const previousAt = saveBlock.indexOf('const previous = await getWelcomeConfig');
    const persistAt = saveBlock.indexOf('await setWelcomeConfig');
    const removeAt = saveBlock.indexOf('await removeWelcomeMediaFile');
    expect(previousAt).toBeGreaterThanOrEqual(0);
    expect(persistAt).toBeGreaterThan(previousAt);
    expect(removeAt).toBeGreaterThan(persistAt);
    expect(welcomeRoute).not.toContain('cleanupStaleWelcomeMedia');
  });

  it('fails closed when Welcome/Goodbye channel validation has no Discord client', () => {
    expect(welcomeRoute).toContain("if (!client) return 'Bot nicht bereit; Channel konnte nicht sicher validiert werden.';");
    expect(goodbyeRoute).toContain("if (!client) return 'Bot nicht bereit; Channel konnte nicht sicher validiert werden.';");
  });

  it('requires delegated autorole managers to possess Discord ManageRoles and role hierarchy authority', () => {
    expect(welcomeRoute).toContain('actor.permissions.has(PermissionFlagsBits.ManageRoles)');
    expect(welcomeRoute).toContain('role.position >= actor.roles.highest.position');
    expect(welcomeRoute).toContain('scope.isOwner');
    expect(welcomeRoute).toContain('if (body.isActive)');
  });

  it('uses one Berlin calendar source for welcome year/month/day/date/time', () => {
    expect(welcomeManager).toContain("timeZone: 'Europe/Berlin', year: 'numeric', month: 'numeric', day: 'numeric'");
    expect(welcomeManager).toContain(".replace(/\\{year\\}/g, calendarParts.year ?? '')");
    expect(welcomeManager).toContain(".replace(/\\{month\\}/g, calendarParts.month ?? '')");
    expect(welcomeManager).toContain(".replace(/\\{day\\}/g, calendarParts.day ?? '')");
  });

  it('paginates complete session evidence in both cleanup identification and remote-remove authorization', () => {
    for (const source of [leaveWhitelist, whitelistIntent]) {
      expect(source).toContain('const SESSION_PAGE_SIZE = 1000;');
      expect(source).toContain("orderBy: { id: 'asc' }");
      expect(source).toContain("cursor: { id: cursor }, skip: 1");
      expect(source).not.toContain('take: 5000');
    }
  });

  it('places the re-whitelist barrier before any outbox lock or ADD creation while leaving REMOVE untouched', () => {
    const entry = whitelistOutbox.indexOf('export async function enqueueWhitelistJob');
    const functionSource = whitelistOutbox.slice(entry);
    const guardAt = functionSource.indexOf("if (operation === 'WHITELIST_ADD')");
    const lockAt = functionSource.indexOf('withNitradoOutboxConnectionLock');
    expect(guardAt).toBeGreaterThanOrEqual(0);
    expect(lockAt).toBeGreaterThan(guardAt);
    expect(whitelistOutbox).toContain('hasOpenLeaveCleanupRequest(scope.guildId, discordId)');
    expect(whitelistOutbox).toContain("code = 'LEAVE_CLEANUP_PENDING'");
  });
});
