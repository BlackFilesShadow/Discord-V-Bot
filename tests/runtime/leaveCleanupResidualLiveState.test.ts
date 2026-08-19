import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(
  path.resolve(process.cwd(), 'src/modules/moderation/guildMemberCleanup.ts'),
  'utf8',
);

describe('Leave-1H residual guild live-state architecture', () => {
  it('removes direct user permission grants only in the leaving guild', () => {
    expect(source).toContain('tx.guildPermissionGrant.deleteMany');
    expect(source).toContain('where: { guildId, userDiscordId: discordId }');
    expect(source).not.toContain('tx.guildPermissionRoleGrant.deleteMany');
  });

  it('discovers faction state through the target guild before deleting member rows', () => {
    const discover = source.indexOf('const factions = await tx.faction.findMany');
    const deleteMembers = source.indexOf('tx.factionMember.deleteMany', discover);

    expect(discover).toBeGreaterThanOrEqual(0);
    expect(deleteMembers).toBeGreaterThan(discover);
    const discoverySlice = source.slice(discover, deleteMembers);
    expect(discoverySlice).toContain('guildId,');
    expect(discoverySlice).toContain('{ members: { some: { userDiscordId: discordId } } }');
    expect(source).toContain('factionId: { in: factionIds }');
    expect(source).toContain('userDiscordId: discordId');
  });

  it('clears leader, deputy and treasurer references with exact guild+user scope', () => {
    expect(source).toContain('where: { guildId, leaderDiscordId: discordId }');
    expect(source).toContain('data: { leaderDiscordId: null }');
    expect(source).toContain('where: { guildId, deputyDiscordId: discordId }');
    expect(source).toContain('data: { deputyDiscordId: null }');
    expect(source).toContain('where: { guildId, treasurerDiscordId: discordId }');
    expect(source).toContain('data: { treasurerDiscordId: null }');
  });

  it('keeps DB cleanup atomic and faction presentation strictly post-transaction best-effort', () => {
    const transaction = source.indexOf('const result = await prisma.$transaction');
    const audit = source.indexOf("logAudit('GUILD_MEMBER_DATA_CLEANUP'", transaction);
    const client = source.indexOf('tryGetDashboardClient()', audit);
    const embed = source.indexOf('postFactionEmbed(client, factionId)', client);

    expect(transaction).toBeGreaterThanOrEqual(0);
    expect(audit).toBeGreaterThan(transaction);
    expect(client).toBeGreaterThan(audit);
    expect(embed).toBeGreaterThan(client);
    expect(source).toContain('postFactionEmbed(client, factionId).catch');
    expect(source).toContain('postFactionList(client, guildId).catch');
  });
});
