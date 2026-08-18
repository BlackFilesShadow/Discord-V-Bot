import fs from 'node:fs';
import path from 'node:path';

const read = (relative: string) => fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8');

const pending = read('src/modules/nitrado/pendingServerAction.ts');
const privileged = read('src/commands/dashboard/privileged.ts');
const money = read('src/modules/economy/pendingAdminMoney.ts');
const schema = read('prisma/pending-server-action.prisma');
const migration = read('prisma/migrations/20260818133000_nitrado_1e_pending_action_lease/migration.sql');

describe('Nitrado-1E durable pending action architecture gate', () => {
  it('separates confirmation claim from terminal consumption with a fenced lease', () => {
    expect(pending).toContain("export type PendingServerActionStatus = 'PENDING' | 'RUNNING' | 'CONSUMED';");
    expect(pending).toContain('export async function claimPendingServerAction(');
    expect(pending).toContain("status: 'RUNNING'");
    expect(pending).toContain('claimToken');
    expect(pending).toContain('claimedAt');
    expect(pending).toContain('export async function completePendingServerAction(');
    expect(pending).toContain("status: 'CONSUMED'");
    expect(pending).toContain('export async function releasePendingServerActionClaim(');
    expect(pending).not.toContain('export async function consumePendingServerAction(');
  });

  it('applies confirmation TTL only to first PENDING claim and allows stale RUNNING recovery', () => {
    const claimAt = pending.indexOf('export async function claimPendingServerAction(');
    const completeAt = pending.indexOf('export async function completePendingServerAction(', claimAt);
    const claimSection = pending.slice(claimAt, completeAt);
    const firstClaimAt = claimSection.indexOf("status: 'PENDING'");
    const retryClaimAt = claimSection.indexOf("status: 'RUNNING'", firstClaimAt + 1);

    expect(firstClaimAt).toBeGreaterThanOrEqual(0);
    expect(retryClaimAt).toBeGreaterThan(firstClaimAt);
    expect(claimSection.slice(firstClaimAt, retryClaimAt)).toContain('expiresAt: { gt: now }');
    expect(claimSection.slice(retryClaimAt)).not.toContain('expiresAt: { gt: now }');
    expect(claimSection.slice(retryClaimAt)).toContain('{ claimToken: null }');
    expect(claimSection.slice(retryClaimAt)).toContain('{ claimedAt: { lte: staleBefore } }');
  });

  it('never consumes before privileged side effects and releases only unexpected failures', () => {
    expect(privileged).toContain('const action = await claimPendingServerAction(');
    expect(privileged).not.toContain('consumePendingServerAction');
    expect(privileged).toContain('const completed = await completePendingServerAction(');
    expect(privileged).toContain('await releasePendingServerActionClaim(');

    const moneyAt = privileged.indexOf("if (action.actionType === ACTIONS.ADD_MONEY || action.actionType === ACTIONS.REMOVE_MONEY)");
    const linkAt = privileged.indexOf("if (action.actionType === ACTIONS.FORCE_LINK)", moneyAt);
    const unlinkAt = privileged.indexOf("if (action.actionType === ACTIONS.FORCE_UNLINK)", linkAt);
    const catchAt = privileged.indexOf('} catch (error) {', unlinkAt);

    const moneySection = privileged.slice(moneyAt, linkAt);
    expect(moneySection.indexOf('await applyPendingAdminMoneyAction(')).toBeGreaterThanOrEqual(0);
    expect(moneySection.indexOf('await finish(')).toBeGreaterThan(moneySection.indexOf('await applyPendingAdminMoneyAction('));

    const linkSection = privileged.slice(linkAt, unlinkAt);
    expect(linkSection.indexOf('await applySuccessfulLinkEconomyEffects({')).toBeGreaterThanOrEqual(0);
    expect(linkSection.lastIndexOf('await finish(')).toBeGreaterThan(linkSection.indexOf('await applySuccessfulLinkEconomyEffects({'));

    const unlinkSection = privileged.slice(unlinkAt, catchAt);
    expect(unlinkSection.indexOf('await unlinkUser(')).toBeGreaterThanOrEqual(0);
    expect(unlinkSection.indexOf('await deactivateLinkRewardState(')).toBeGreaterThan(unlinkSection.indexOf('await unlinkUser('));
    expect(unlinkSection.indexOf('await finish(')).toBeGreaterThan(unlinkSection.indexOf('await deactivateLinkRewardState('));
  });

  it('makes pending admin money exact-once using the action id before any balance mutation', () => {
    const ledgerAt = money.indexOf('await tx.economyLedgerEntry.create({');
    const negativeMutationAt = money.indexOf('await tx.economyAccount.updateMany({');
    const positiveMutationAt = money.indexOf('await tx.economyAccount.upsert({');
    const auditAt = money.indexOf('await tx.economyTransaction.create({');

    expect(money).toContain('const idempotencyKey = `pending-action:${input.actionId}:admin-pay`;');
    expect(ledgerAt).toBeGreaterThanOrEqual(0);
    expect(negativeMutationAt).toBeGreaterThan(ledgerAt);
    expect(positiveMutationAt).toBeGreaterThan(ledgerAt);
    expect(auditAt).toBeGreaterThan(negativeMutationAt);
    expect(auditAt).toBeGreaterThan(positiveMutationAt);
    expect(money).toContain("if (isUniqueViolation(error)) return { applied: false };");
  });

  it('ships schema and migration support for RUNNING lease fields', () => {
    expect(schema).toContain('claimToken      String?');
    expect(schema).toContain('claimedAt       DateTime?');
    expect(schema).toContain('@@index([status, claimedAt])');

    expect(migration).toContain('ADD COLUMN IF NOT EXISTS "claimToken" TEXT');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS "claimedAt" TIMESTAMP(3)');
    expect(migration).toContain("CHECK (\"status\" IN ('PENDING', 'RUNNING', 'CONSUMED'))");
    expect(migration).toContain('"PendingServerAction_status_claimedAt_idx"');
  });
});
