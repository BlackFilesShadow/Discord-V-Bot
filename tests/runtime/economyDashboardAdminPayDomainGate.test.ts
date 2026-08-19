import fs from 'node:fs';
import path from 'node:path';

function read(relative: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8');
}

const api = read('dashboard-ui/src/lib/api.ts');
const middleware = read('src/dashboard/middleware/idempotency.ts');
const route = read('src/dashboard/routes/v2/economy.ts');
const domain = read('src/modules/economy/dashboardAdminPay.ts');

describe('Economy dashboard admin-pay domain idempotency architecture', () => {
  it('builds on the retry-stable dashboard HTTP idempotency contract from Economy-1L', () => {
    expect(api).toContain('acquireMutationIdempotencyKey(signature)');
    expect(api).toContain("headers['X-Idempotency-Key'] = lease.key");
    expect(api).toContain('if (lease) releaseMutationIdempotencyKey(lease)');
    expect(api).toContain('window.sessionStorage');
    expect(api).toContain("crypto.subtle.digest('SHA-256'");

    expect(middleware).toContain('const takeover = await prisma.idempotencyKey.updateMany');
    expect(middleware).toContain('status: existing.status');
    expect(middleware).toContain('createdAt: existing.createdAt');
    expect(middleware).toContain('if (takeover.count !== 1)');
  });

  it('requires the same HTTP key at the money boundary without adding a second UI operation contract', () => {
    const handlerStart = route.indexOf("economyRouter.post('/accounts/:userDiscordId/admin-pay'");
    const handlerEnd = route.indexOf('\n});', handlerStart);
    const handler = route.slice(handlerStart, handlerEnd);

    expect(handlerStart).toBeGreaterThanOrEqual(0);
    expect(handler).toContain("req.header('x-idempotency-key')");
    expect(handler).toContain('applyDashboardAdminPay({');
    expect(handler).toContain('httpIdempotencyKey');
    expect(handler).toContain('if (result.applied)');
    expect(handler).toContain("logAuditDb('ECONOMY_ADMIN_PAY'");
    expect(handler).toContain('applied: result.applied');
    expect(handler).not.toContain('operationId');
  });

  it('preserves the canonical economy scope-migration guard before the domain transaction', () => {
    expect(domain).toContain("import { assertEconomyScopeReady } from './scopeMigration';");
    const scopeGuard = domain.indexOf('await assertEconomyScopeReady(input.guildId, input.nitradoConnId);');
    const transaction = domain.indexOf('await prisma.$transaction(async tx =>');
    const ledgerClaim = domain.indexOf('await tx.economyLedgerEntry.create', transaction);

    expect(scopeGuard).toBeGreaterThanOrEqual(0);
    expect(transaction).toBeGreaterThan(scopeGuard);
    expect(ledgerClaim).toBeGreaterThan(transaction);
  });

  it('hashes the raw HTTP key and claims the economy ledger before any balance mutation', () => {
    expect(domain).toContain("crypto.createHash('sha256')");
    expect(domain).toContain('`${actorDiscordId}:${rawKey}`');
    expect(domain).toContain('`dashboard-admin-pay:${hash}`');
    expect(domain).toContain('hash.slice(0, 32)');

    const transaction = domain.indexOf('await prisma.$transaction(async tx =>');
    const ledgerClaim = domain.indexOf('await tx.economyLedgerEntry.create', transaction);
    const debit = domain.indexOf('await tx.economyAccount.updateMany', ledgerClaim);
    const credit = domain.indexOf('await tx.economyAccount.upsert', ledgerClaim);
    const auditTransaction = domain.indexOf('await tx.economyTransaction.create', ledgerClaim);

    expect(transaction).toBeGreaterThanOrEqual(0);
    expect(ledgerClaim).toBeGreaterThan(transaction);
    expect(debit).toBeGreaterThan(ledgerClaim);
    expect(credit).toBeGreaterThan(ledgerClaim);
    expect(auditTransaction).toBeGreaterThan(ledgerClaim);
  });

  it('accepts a replay only when the committed ledger payload matches exactly', () => {
    expect(domain).toContain('async function assertExactReplay');
    expect(domain).toContain('existing.guildId === input.guildId');
    expect(domain).toContain('existing.nitradoConnId === input.nitradoConnId');
    expect(domain).toContain('existing.userDiscordId === input.targetUserId');
    expect(domain).toContain('existing.walletDelta === input.delta');
    expect(domain).toContain("existing.type === 'ADMIN_PAY'");
    expect(domain).toContain('existing.reason === input.reason');
    expect(domain).toContain('existing.sourceRef === sourceRef');
    expect(domain).toContain('await assertExactReplay(input, ledgerKey, sourceRef)');
  });
});
