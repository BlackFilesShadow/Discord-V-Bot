import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(
  path.resolve(process.cwd(), 'src/modules/economy/bankInterest.ts'),
  'utf8',
);

describe('Economy-1I bank-interest pagination architecture', () => {
  it('uses stable createdAt+id keyset pagination for positive scoped bank accounts', () => {
    expect(source).toContain("orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]");
    expect(source).toContain('{ createdAt: { gt: cursor.createdAt } }');
    expect(source).toContain("{ createdAt: cursor.createdAt, id: { gt: cursor.id } }");
    expect(source).toContain('bankBalance: { gt: 0 }');
    expect(source).toContain('guildId: args.guildId');
    expect(source).toContain('nitradoConnId: args.nitradoConnId');
  });

  it('treats limit as bounded page size rather than total-account cap', () => {
    expect(source).toContain('const pageSize = Math.max(1, Math.min(2_000, Math.trunc(args.limit ?? 500)))');
    expect(source).toContain('take: pageSize');
    expect(source).toContain('for (;;)');
    expect(source).toContain('if (accounts.length < pageSize) break;');
  });

  it('creates the daily completion marker only after the pagination loop', () => {
    const loop = source.indexOf('for (;;)');
    const pageBreak = source.indexOf('if (accounts.length < pageSize) break;', loop);
    const runMarker = source.indexOf('await createRunMarker(client, {', pageBreak);

    expect(loop).toBeGreaterThanOrEqual(0);
    expect(pageBreak).toBeGreaterThan(loop);
    expect(runMarker).toBeGreaterThan(pageBreak);
  });

  it('fails closed on real marker persistence errors and tolerates only unique parallel collision', () => {
    expect(source).toContain("candidate.code === 'P2002' || candidate.code === '23505' || candidate.meta?.code === '23505'");
    expect(source).toContain('if (!isUniqueViolation(error)) throw error;');
    expect(source).not.toContain('catch { /* Unique-Kollision');
  });

  it('keeps per-user ledger idempotency scoped by guild, server and run date', () => {
    expect(source).toContain('`interest:${args.guildId}:${args.nitradoConnId}:${args.runDate}:${subjectKey}`');
  });
});