import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('Moderation Case Administration — Production-Sicherheitsinvarianten', () => {
  const admin = read('src/modules/moderation/caseAdministration.ts');
  const command = read('src/commands/user/caseManagement.ts');

  it('liest und mutiert Cases ausschliesslich im Origin-Guild-Scope', () => {
    expect(admin).toContain('where: { caseNumber, guildId: guild.id }');
    expect(admin).toContain('where: { id: modCase.id, guildId: guild.id, isActive: true, revokedAt: null }');
    expect(admin).toContain("where: { status: 'PENDING', case: { guildId } }");
    expect(command).toContain('getCaseDetails(caseNumber, interaction.guildId)');
    expect(command).toContain('getUserCases(target.id, interaction.guildId)');
  });

  it('claimt Ruecknahmen atomar und verhindert parallele Discord-Sideeffects', () => {
    expect(admin).toContain("const CLAIM_PREFIX = 'pending:';");
    expect(admin).toContain('const claim = await prisma.moderationCase.updateMany');
    expect(admin).toContain('data: { isActive: false, revokedAt: claimedAt, revokedBy: claimToken }');
    expect(admin).toContain('if (claim.count !== 1)');
    expect(admin).toContain('await reverseDiscordSanction');
  });

  it('rollt den Case-Claim bei Discord-Fehlern exakt und auditierbar zurueck', () => {
    expect(admin).toContain('where: { id: modCase.id, guildId: guild.id, isActive: false, revokedBy: claimToken }');
    expect(admin).toContain('data: { isActive: true, revokedAt: null, revokedBy: null }');
    expect(admin).toContain("logAudit('MODERATION_REVOKE_FAILED'");
    expect(admin).toContain('rollbackSucceeded: rollback.count === 1');
  });

  it('prueft Berechtigung und Rollen-Hierarchie erneut im Backend', () => {
    expect(admin).toContain('moderator.permissions.has(permission)');
    expect(admin).toContain('target.roles.highest.position >= moderator.roles.highest.position');
    expect(admin).toContain('target.roles.highest.position >= bot.roles.highest.position');
    expect(command).toContain('.setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)');
  });

  it('hebt BAN und MUTE real auf und behandelt Unknown Ban idempotent', () => {
    expect(admin).toContain("action === 'BAN' || action === 'TEMP_BAN'");
    expect(admin).toContain('await guild.members.unban(targetDiscordId, reason)');
    expect(admin).toContain('Number((error as { code?: unknown }).code) === 10026');
    expect(admin).toContain("action === 'MUTE' || action === 'TEMP_MUTE'");
    expect(admin).toContain('await member.timeout(null, reason)');
  });

  it('claimt Appeals vor Review und genehmigt aktive Appeals nur nach sicherer Case-Ruecknahme', () => {
    expect(admin).toContain('const claim = await prisma.appeal.updateMany');
    expect(admin).toContain("where: { id: appeal.id, status: 'PENDING', reviewedBy: null, reviewedAt: null }");
    const approveStart = admin.indexOf("if (decision === 'APPROVED' && modCase.isActive)");
    const revokeStart = admin.indexOf('const revoked = await revokeModerationCase', approveStart);
    const finalizeStart = admin.indexOf('const finalize = await prisma.appeal.updateMany', approveStart);
    expect(approveStart).toBeGreaterThan(-1);
    expect(revokeStart).toBeGreaterThan(approveStart);
    expect(finalizeStart).toBeGreaterThan(revokeStart);
  });

  it('finalisiert Claims nur mit ihrem eindeutigen Token und protokolliert kritische Inkonsistenzen', () => {
    expect(admin).toContain('revokedBy: claimToken');
    expect(admin).toContain('data: { revokedBy: moderatorDiscordId }');
    expect(admin).toContain("logAudit('MODERATION_REVOKE_FINALIZE_FAILED'");
    expect(admin).toContain("logAudit('APPEAL_REVIEW_FINALIZE_FAILED'");
  });
});
