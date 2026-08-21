import fs from 'node:fs';
import { normalizeSourceNewlines } from '../helpers/sourceText';
import path from 'node:path';

const read = (relative: string) => normalizeSourceNewlines(fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8'));

const indexSource = read('src/index.ts');
const addSource = read('src/events/guildMemberAdd.ts');
const removeSource = read('src/events/guildMemberRemove.ts');
const memberUpdateSource = read('src/events/guildMemberUpdate.ts');
const userUpdateSource = read('src/events/userUpdate.ts');
const awarenessSource = read('src/modules/ai/memberAwareness.ts');

describe('User-1 recognition lifecycle wiring', () => {
  it('registers guildMemberUpdate and userUpdate in the central safe event list', () => {
    expect(indexSource).toContain("import guildMemberUpdateEvent from './events/guildMemberUpdate';");
    expect(indexSource).toContain("import userUpdateEvent from './events/userUpdate';");
    expect(indexSource).toContain('guildMemberUpdateEvent,');
    expect(indexSource).toContain('userUpdateEvent,');
    expect(indexSource).toContain('registerBotEventsSafely(client, events);');
  });

  it('updates nickname/role recognition only from the new exact GuildMember', () => {
    expect(memberUpdateSource).toContain('name: Events.GuildMemberUpdate');
    expect(memberUpdateSource).toContain('const member = newMember as GuildMember;');
    expect(memberUpdateSource).toContain('await syncMemberProfile(member);');
    expect(memberUpdateSource).not.toMatch(/roles\.add|roles\.remove|setNickname|setRoles|permission/i);
  });

  it('propagates a global rename by rebuilding each cached current guild profile independently', () => {
    expect(userUpdateSource).toContain('name: Events.UserUpdate');
    expect(userUpdateSource).toContain('for (const guild of user.client.guilds.cache.values())');
    expect(userUpdateSource).toContain('guild.members.cache.get(user.id)');
    expect(userUpdateSource).toContain('await syncMemberProfile(member);');
    expect(userUpdateSource).not.toContain('guildMemberProfile.updateMany');
  });

  it('makes join/rejoin activation deterministic and snapshots the final member state before leave', () => {
    expect(addSource).toContain('await syncMemberProfile(m);');
    expect(addSource).not.toContain('void syncMemberProfile(m);');

    const syncAt = removeSource.indexOf('await syncMemberProfile(m);');
    const leftAt = removeSource.indexOf('await markMemberLeft(m.guild.id, m.user.id);');
    expect(syncAt).toBeGreaterThanOrEqual(0);
    expect(leftAt).toBeGreaterThan(syncAt);
  });

  it('keeps persisted recognition separate from authorization and uses exact guild keys', () => {
    expect(awarenessSource).toContain('Recognition-/Kontextdaten');
    expect(awarenessSource).toContain('Trusted Runtime');
    expect(awarenessSource).toContain('guildId_discordId: { guildId: member.guild.id, discordId: member.id }');

    const identityStart = awarenessSource.indexOf('export async function syncDiscordUserIdentity');
    const identityEnd = awarenessSource.indexOf('/**', identityStart + 1);
    const identityFunction = awarenessSource.slice(identityStart, identityEnd);
    expect(identityFunction).toContain('prisma.user.updateMany');
    expect(identityFunction).not.toMatch(/role\s*:|status\s*:|isManufacturer\s*:|permission/i);
  });

  it('preserves the member profile on leave and clears only in-memory pending activity', () => {
    const markStart = awarenessSource.indexOf('export async function markMemberLeft');
    const markEnd = awarenessSource.indexOf('/**', markStart + 1);
    const markFunction = awarenessSource.slice(markStart, markEnd);

    expect(markFunction).toContain('clearPendingMemberActivity(guildId, discordId);');
    expect(markFunction).toContain('guildMemberProfile.updateMany');
    expect(markFunction).toContain('where: { guildId, discordId, isLeft: false }');
    expect(markFunction).not.toMatch(/\.delete|\.deleteMany/);
  });
});
