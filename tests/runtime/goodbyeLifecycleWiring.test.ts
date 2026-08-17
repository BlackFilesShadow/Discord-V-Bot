import fs from 'node:fs';
import path from 'node:path';

const read = (relative: string) => fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8');

const removeSource = read('src/events/guildMemberRemove.ts');
const managerSource = read('src/modules/welcome/goodbyeManager.ts');
const awarenessSource = read('src/modules/ai/memberAwareness.ts');

describe('Goodbye-1 + Leave-1E leave lifecycle wiring', () => {
  it('snapshots and marks the exact guild profile before goodbye and cleanup enqueue', () => {
    const syncAt = removeSource.indexOf('await syncMemberProfile(m);');
    const leftAt = removeSource.indexOf('await markMemberLeft(m.guild.id, m.user.id);');
    const goodbyeAt = removeSource.indexOf('await sendConfiguredGoodbye(m);');
    const configAt = removeSource.indexOf('await getLeaveCleanupConfig(m.guild.id);');
    const enqueueAt = removeSource.indexOf('await enqueueLeaveCleanupRequest({');

    expect(syncAt).toBeGreaterThanOrEqual(0);
    expect(leftAt).toBeGreaterThan(syncAt);
    expect(goodbyeAt).toBeGreaterThan(leftAt);
    expect(configAt).toBeGreaterThan(goodbyeAt);
    expect(enqueueAt).toBeGreaterThan(configAt);
  });

  it('keeps goodbye best-effort and never performs destructive cleanup directly in the gateway event', () => {
    expect(removeSource).toContain("import { sendConfiguredGoodbye } from '../modules/welcome/goodbyeManager';");
    expect(removeSource).toContain('await sendConfiguredGoodbye(m);');
    expect(removeSource).toContain('} catch (goodbyeError) {');
    expect(removeSource).toContain('deletePlayerDataOnLeave');
    expect(removeSource).toContain('enqueueLeaveCleanupRequest');
    expect(removeSource).not.toContain('cleanupGuildMemberData');
    expect(removeSource).not.toContain('runLeaveWhitelistCleanupStep');
    expect(removeSource).not.toContain('runLeaveStatsSessionsCleanupStep');
    expect(removeSource).not.toContain('runLeaveLinkEconomy');
  });

  it('resolves the stored identity with the exact guild and discord id pair', () => {
    expect(managerSource).toContain('getMemberProfile(member.guild.id, member.user.id)');
    expect(awarenessSource).toContain('guildId_discordId: { guildId, discordId }');
  });

  it('does not reuse persisted role or permission context as goodbye authorization', () => {
    const identityStart = managerSource.indexOf('export async function resolveLastKnownGoodbyeIdentity');
    const identityEnd = managerSource.indexOf('export function renderGoodbyeMessage', identityStart);
    const identityFunction = managerSource.slice(identityStart, identityEnd);

    expect(identityFunction).toContain('getMemberProfile(member.guild.id, member.user.id)');
    expect(identityFunction).not.toMatch(/topRolesJson|permission|roles\.cache|permissionsFor/i);
  });

  it('does not enable Discord mention pings for goodbye delivery', () => {
    const sendStart = managerSource.indexOf('export async function sendConfiguredGoodbye');
    const sendFunction = managerSource.slice(sendStart);

    expect(sendFunction).toContain('sendWelcomeMessages(channel, { text: finalText });');
    expect(sendFunction).not.toContain('mentionUserId');
  });
});
