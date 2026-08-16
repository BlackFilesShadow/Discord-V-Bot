import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('Moderation Expiry — Race-Sicherheitsinvarianten', () => {
  const expiry = read('src/modules/moderation/caseExpiry.ts');
  const index = read('src/index.ts');

  it('verwendet im Runtime-Scheduler ausschliesslich den race-sicheren Expiry-Pfad', () => {
    expect(index).toContain("import { processExpiredCasesSafely } from './modules/moderation/caseExpiry';");
    expect(index).toContain('const n = await processExpiredCasesSafely(guild);');
    expect(index).not.toContain("import { processExpiredCases } from './modules/moderation/caseManager';");
  });

  it('claimt jeden abgelaufenen Case per Guild-CAS bevor Discord veraendert wird', () => {
    const claimStart = expiry.indexOf('const claim = await prisma.moderationCase.updateMany');
    const sideEffectStart = expiry.indexOf("if (modCase.action === 'TEMP_BAN')", claimStart);
    expect(claimStart).toBeGreaterThan(-1);
    expect(sideEffectStart).toBeGreaterThan(claimStart);
    expect(expiry).toContain('where: { id: modCase.id, guildId: guild.id, isActive: true, revokedAt: null }');
    expect(expiry).toContain('data: { isActive: false, revokedAt: claimedAt, revokedBy: claimToken }');
    expect(expiry).toContain('if (claim.count !== 1) continue;');
  });

  it('finalisiert nur den eigenen Claim und rollt Sideeffect-Fehler wieder zurueck', () => {
    expect(expiry).toContain('where: { id: modCase.id, guildId: guild.id, isActive: false, revokedBy: claimToken }');
    expect(expiry).toContain("data: { revokedBy: 'system' }");
    expect(expiry).toContain('data: { isActive: true, revokedAt: null, revokedBy: null }');
    expect(expiry).toContain("logAudit('MODERATION_EXPIRE_FAILED'");
    expect(expiry).toContain("logAudit('MODERATION_EXPIRE_FINALIZE_FAILED'");
  });

  it('behandelt bereits aufgehobene Bans und Mutes idempotent', () => {
    expect(expiry).toContain('Number((error as { code?: unknown }).code) === 10026');
    expect(expiry).toContain('member?.isCommunicationDisabled()');
    expect(expiry).toContain("await member.timeout(null, 'Temporaerer Mute abgelaufen')");
  });
});
