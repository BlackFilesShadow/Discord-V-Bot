import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(
  path.resolve(process.cwd(), 'src/commands/dashboard/factions.ts'),
  'utf8',
);

describe('persistent faction presentation after Discord membership commands', () => {
  it('refreshes the durable faction embed and overview after /join and /leave without delaying their replies', () => {
    expect(source).toContain('postFactionEmbed, postFactionList');
    expect(source).toContain('function refreshPersistentFactionEmbeds(');
    expect(source).toContain('void postFactionEmbed(client, factionId).catch');
    expect(source).toContain('void postFactionList(client, guildId).catch');

    const join = source.indexOf("logAudit('FACTION_JOIN'");
    const joinRefresh = source.indexOf('refreshPersistentFactionEmbeds(interaction.client, String(scope.guildId), result.factionId);', join);
    const joinReply = source.indexOf("if (result.role === 'MEMBER')", join);
    expect(joinRefresh).toBeGreaterThan(join);
    expect(joinReply).toBeGreaterThan(joinRefresh);

    const leave = source.indexOf("logAudit('FACTION_LEAVE'");
    const leaveRefresh = source.indexOf('refreshPersistentFactionEmbeds(interaction.client, String(scope.guildId), member.factionId);', leave);
    const leaveReply = source.indexOf("await statusReply(interaction, roleSynced", leave);
    expect(leaveRefresh).toBeGreaterThan(leave);
    expect(leaveReply).toBeGreaterThan(leaveRefresh);
  });
});
