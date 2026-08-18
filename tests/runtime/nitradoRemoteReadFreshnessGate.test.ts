import fs from 'node:fs';
import path from 'node:path';

const serverBan = fs.readFileSync(
  path.resolve(process.cwd(), 'src/commands/dashboard/serverBan.ts'),
  'utf8',
);
const dashboardWhitelist = fs.readFileSync(
  path.resolve(process.cwd(), 'src/dashboard/routes/v2/whitelist.ts'),
  'utf8',
);
const leaveWhitelist = fs.readFileSync(
  path.resolve(process.cwd(), 'src/modules/moderation/leaveCleanupWhitelist.ts'),
  'utf8',
);

function expectOrdered(source: string, anchors: string[]): void {
  let previous = -1;
  for (const anchor of anchors) {
    const next = source.indexOf(anchor, previous + 1);
    expect(next).toBeGreaterThan(previous);
    previous = next;
  }
}

describe('Nitrado-1Q remote-read freshness gate', () => {
  it('fenced /server-unban from fresh binding read through local Ban/Outbox commit', () => {
    const start = serverBan.indexOf('export const serverUnbanCommand');
    const end = serverBan.indexOf('export const serverBanListCommand', start);
    const body = serverBan.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expectOrdered(body, [
      'readCurrentAdmBinding({ id: target.id, guildId: scope.guildId })',
      '.getBanlist(binding.nitradoServerId)',
      'withFreshAdmBinding(binding',
      'tx.serverBanEntry.upsert',
      'enqueueServerBanRemove(',
    ]);
    expect(body).not.toContain('clientForTarget(target).getBanlist');
  });

  it('revalidates dashboard whitelist preview/apply after the remote snapshot', () => {
    const start = dashboardWhitelist.indexOf("whitelistRouter.post('/sync'");
    const end = dashboardWhitelist.indexOf("whitelistRouter.get('/channels'", start);
    const body = dashboardWhitelist.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expectOrdered(body, [
      'readCurrentAdmBinding({ id: connId, guildId: scope.guildId })',
      '.getWhitelist(binding.nitradoServerId)',
      "if (mode === 'preview')",
      'withFreshAdmBinding(binding',
      'res.json({ ok: true, preview: true, diff })',
    ]);

    const applyFence = body.indexOf('await withFreshAdmBinding(binding, async () => {', body.indexOf("if (mode === 'preview')"));
    const firstApplyWrite = body.indexOf('await prisma.whitelistEntry.create({', applyFence);
    const firstApplyOutbox = body.indexOf('await enqueueWhitelistAdd(', applyFence);
    expect(applyFence).toBeGreaterThanOrEqual(0);
    expect(firstApplyWrite).toBeGreaterThan(applyFence);
    expect(firstApplyOutbox).toBeGreaterThan(applyFence);
  });

  it('fences both leave-cleanup mutation phases around one versioned remote read', () => {
    const remoteRead = leaveWhitelist.indexOf('async function readRemoteWhitelist');
    const processLink = leaveWhitelist.indexOf('async function processLink');
    expect(remoteRead).toBeGreaterThanOrEqual(0);
    expect(processLink).toBeGreaterThan(remoteRead);

    const readBody = leaveWhitelist.slice(remoteRead, processLink);
    expectOrdered(readBody, [
      'readCurrentAdmBinding({ id: args.nitradoConnId, guildId: args.guildId })',
      '.getWhitelist(binding.nitradoServerId)',
      'return {',
      'binding,',
      'identifiers:',
    ]);

    const body = leaveWhitelist.slice(processLink);
    const firstFence = body.indexOf('await withFreshAdmBinding(binding');
    const firstMutation = body.indexOf('tx.whitelistEntry.updateMany', firstFence);
    const secondFence = body.indexOf('await withFreshAdmBinding(binding', firstFence + 1);
    const finalDelete = body.indexOf('tx.whitelistEntry.deleteMany', secondFence);

    expect(firstFence).toBeGreaterThanOrEqual(0);
    expect(firstMutation).toBeGreaterThan(firstFence);
    expect(secondFence).toBeGreaterThan(firstMutation);
    expect(finalDelete).toBeGreaterThan(secondFence);
  });
});