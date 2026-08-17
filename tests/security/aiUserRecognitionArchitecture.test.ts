import fs from 'fs';
import path from 'path';

describe('AI-17 user recognition architecture', () => {
  const recognition = fs.readFileSync(path.join(process.cwd(), 'src/modules/ai/userRecognition.ts'), 'utf8');
  const contextBuilder = fs.readFileSync(path.join(process.cwd(), 'src/modules/ai/contextBuilder.ts'), 'utf8');

  it('uses the canonical GameIdentityLink scope and VERIFIED state fail-closed', () => {
    expect(recognition).toContain('gameIdentityLink.findMany');
    expect(recognition).toContain("status: 'VERIFIED'");
    expect(recognition).toContain('guildId,');
    expect(recognition).toContain('nitradoConnId,');
    expect(recognition).toContain('userDiscordId,');
    expect(recognition).toContain('unlinkedAt: null');
    expect(recognition).toContain('links.length !== 1');
  });

  it('does not return secret identity material to the AI layer', () => {
    const returnBlock = recognition.slice(recognition.indexOf('return {', recognition.indexOf('const matching')));
    expect(returnBlock).not.toContain('identityHash:');
    expect(returnBlock).not.toContain('gameId:');
    expect(returnBlock).not.toContain('challengeCode');
    expect(contextBuilder).not.toMatch(/userLines\.push\([^\n]*(identityHash|challengeCode|gameId)/);
  });

  it('keeps recognition downstream of exact runtime scope and current member identity', () => {
    expect(contextBuilder).toContain('const scope = await resolveRuntimeKnowledgeScope(guild.id, question)');
    expect(contextBuilder).toContain('if (scope && member && discordUser');
    expect(contextBuilder).toContain('member.guild.id === guild.id');
    expect(contextBuilder).toContain('member.user.id === discordUser.id');
    expect(contextBuilder).toContain('nitradoConnId: scope.id');
  });

  it('labels recognition and persisted profile data as non-authoritative for permissions', () => {
    expect(contextBuilder).toContain('Recognition, KEINE Berechtigungsentscheidung');
    expect(contextBuilder).toContain('Persistierte Bot-Profilrolle (Kontext, keine Berechtigung)');
    expect(contextBuilder).toContain('persistierte Historie dieser Guild; keine Berechtigungsquelle');
    expect(recognition).not.toMatch(/hasPermission|canManage|isAdmin|isOwner|authorize|authorizationResult/);
  });
});
