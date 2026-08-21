import fs from 'node:fs';
import { normalizeSourceNewlines } from '../helpers/sourceText';
import path from 'node:path';

function source(file: string): string {
  return normalizeSourceNewlines(fs.readFileSync(path.join(process.cwd(), file), 'utf8'));
}

function functionSlice(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from + start.length);
  expect(from).toBeGreaterThanOrEqual(0);
  expect(to).toBeGreaterThan(from);
  return text.slice(from, to);
}

describe('Leave/Rejoin production lifecycle gate', () => {
  it('legt beim Discord-Leave die durable Cleanup-Barriere vor Profilmarker und Goodbye an', () => {
    const text = functionSlice(
      source('src/events/guildMemberRemove.ts'),
      'execute: async (member: unknown)',
      'export default guildMemberRemoveEvent',
    );
    const enqueue = text.indexOf('enqueueLeaveCleanupRequest({');
    const sync = text.indexOf('await syncMemberProfile(m)');
    const left = text.indexOf('await markMemberLeft');
    const goodbye = text.indexOf('await sendConfiguredGoodbye');

    expect(enqueue).toBeGreaterThanOrEqual(0);
    expect(sync).toBeGreaterThan(enqueue);
    expect(left).toBeGreaterThan(sync);
    expect(goodbye).toBeGreaterThan(left);
  });

  it('blockiert beim Rejoin frische Level-State-Erzeugung solange der alte Cleanup offen ist', () => {
    const text = functionSlice(
      source('src/events/guildMemberAdd.ts'),
      'execute: async (member: unknown)',
      'export default guildMemberAddEvent',
    );
    const profile = text.indexOf('await syncMemberProfile(m)');
    const guard = text.indexOf('await hasOpenLeaveCleanupRequest');
    const baseline = text.indexOf('await prisma.levelData.upsert');

    expect(profile).toBeGreaterThanOrEqual(0);
    expect(guard).toBeGreaterThan(profile);
    expect(baseline).toBeGreaterThan(guard);
    expect(text).toContain('if (!leaveCleanupOpen)');
  });

  it('haelt die destruktive Worker-Reihenfolge und finalisiert Rejoin-State vor Completion', () => {
    const text = functionSlice(
      source('src/modules/moderation/leaveCleanupWorker.ts'),
      'export async function processLeaveCleanupRequest',
      '/** Ein Worker-Tick',
    );
    const whitelist = text.indexOf("details.step === 'WHITELIST'");
    const stats = text.indexOf("details.step === 'STATS_SESSIONS'");
    const economy = text.indexOf("details.step === 'LINK_ECONOMY'");
    const guildData = text.indexOf("details.step === 'GUILD_DATA'");
    const rejoin = text.indexOf('await finalizeLeaveRejoinState(request, guildId, discordId)', guildData);
    const completeStep = text.indexOf("details.step === 'COMPLETE'");
    const complete = text.indexOf('await completeLeaveCleanupRequest', completeStep);

    expect(whitelist).toBeGreaterThanOrEqual(0);
    expect(stats).toBeGreaterThan(whitelist);
    expect(economy).toBeGreaterThan(stats);
    expect(guildData).toBeGreaterThan(economy);
    expect(rejoin).toBeGreaterThan(guildData);
    expect(completeStep).toBeGreaterThan(rejoin);
    expect(complete).toBeGreaterThan(completeStep);
  });

  it('serialisiert Link-Persistierung gegen OPEN und gerade vollendete Leave-Generationen', () => {
    const full = source('src/modules/linking/linkService.ts');
    const persist = functionSlice(full, 'async function persistVerifiedLink', 'async function linkResolvedIdentity');

    expect(persist).toContain('pg_advisory_xact_lock(hashtextextended($1, 0))');
    expect(persist).toContain('leaveCleanupJobKey(scope.guildId, userDiscordId)');
    expect(persist).toContain("status: { in: ['PENDING', 'IN_PROGRESS', 'FAILED'] }");
    expect(persist).toContain('leaveCleanupReceiptFingerprint(scope.guildId, userDiscordId, secret)');
    expect(persist).toContain("status: 'COMPLETED'");
    expect(persist).toContain("orderBy: { completedAt: 'desc' }");
    expect(persist).toContain('now <= completedLeave.completedAt');
    expect(persist.indexOf('completedLeave')).toBeLessThan(persist.indexOf('tx.gameIdentityLink.upsert'));
  });

  it('serialisiert Reward-Epoche und Startbonus gegen denselben Leave-Enqueue-Key', () => {
    const full = source('src/modules/linking/linkRewards.ts');
    const activate = functionSlice(full, 'export async function activateLinkRewardState', '/** Unlink');
    const grant = functionSlice(full, 'export async function grantStartBalanceForLink', '/**\n * Aktivierung + einmalige');

    for (const text of [activate, grant]) {
      expect(text).toContain('lockLeaveSubject');
      expect(text).toContain('hasOpenLeaveCleanupInTx');
    }
    expect(full).toContain('pg_advisory_xact_lock(hashtextextended($1, 0))');
    expect(activate).toContain('assertFreshVerifiedLinkInTx');
    expect(full).toContain('link.verifiedAt <= receipt.completedAt');
    expect(full).toContain("status: 'VERIFIED'");
    expect(grant).toContain('hasCompletedLeaveReceiptInTx');
    expect(grant).toContain('startBalanceEligible: false');
    expect(grant.indexOf('hasCompletedLeaveReceiptInTx')).toBeLessThan(grant.indexOf('economyLedgerEntry.create'));
  });
});
