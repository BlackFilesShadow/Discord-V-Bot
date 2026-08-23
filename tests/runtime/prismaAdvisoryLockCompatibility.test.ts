import fs from 'node:fs';
import path from 'node:path';
import { rewritePrismaVoidRawQueryArgs } from '../../src/database/rawQueryCompatibility';

describe('Prisma advisory-lock void compatibility', () => {
  it('rewrites transaction advisory locks to expose only a supported INT4 result', () => {
    const args = [
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      'poll:poll-1',
    ];

    const rewritten = rewritePrismaVoidRawQueryArgs('$queryRawUnsafe', args);

    expect(rewritten).not.toBe(args);
    expect(rewritten[0]).toBe(
      'WITH "__vbot_advisory_lock" AS (SELECT pg_advisory_xact_lock(hashtextextended($1, 0))) ' +
      'SELECT 1::int AS "locked" FROM "__vbot_advisory_lock"',
    );
    expect(rewritten.slice(1)).toEqual(['poll:poll-1']);
  });

  it('supports the two-int transaction lock overload without changing parameter order', () => {
    const args = ['SELECT pg_advisory_xact_lock($1, $2);', 123, -456];
    const rewritten = rewritePrismaVoidRawQueryArgs('$queryRawUnsafe', args);

    expect(rewritten[0]).toContain('SELECT pg_advisory_xact_lock($1, $2)');
    expect(rewritten[0]).toContain('SELECT 1::int AS "locked"');
    expect(rewritten.slice(1)).toEqual([123, -456]);
  });

  it('also covers shared xact locks, which return PostgreSQL void as well', () => {
    const args = ['SELECT pg_advisory_xact_lock_shared($1)', 42];
    const rewritten = rewritePrismaVoidRawQueryArgs('$queryRawUnsafe', args);
    expect(rewritten[0]).toContain('WITH "__vbot_advisory_lock" AS');
    expect(rewritten.slice(1)).toEqual([42]);
  });

  it('does not touch ordinary raw queries or other Prisma operations', () => {
    const ordinary = ['SELECT "identityHash" FROM "EconomyLinkRewardState" WHERE "guildId"=$1', 'g1'];
    expect(rewritePrismaVoidRawQueryArgs('$queryRawUnsafe', ordinary)).toBe(ordinary);

    const lock = ['SELECT pg_advisory_xact_lock($1)', 1];
    expect(rewritePrismaVoidRawQueryArgs('findMany', lock)).toBe(lock);
  });

  it('pins the production Prisma extension hook so all existing lock callsites are covered centrally', () => {
    const prismaSource = fs.readFileSync(path.resolve('src/database/prisma.ts'), 'utf8');
    expect(prismaSource).toContain("import { rewritePrismaVoidRawQueryArgs } from './rawQueryCompatibility';");
    expect(prismaSource).toContain('rewritePrismaVoidRawQueryArgs(operation, args)');
    expect(prismaSource).toContain('query(compatibleArgs as typeof args)');
  });

  it('guards every current production transaction advisory-lock SQL callsite against void row decoding', () => {
    const root = path.resolve('src');
    const offending: string[] = [];

    const visit = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          visit(full);
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
        const source = fs.readFileSync(full, 'utf8');
        if (!source.includes('SELECT pg_advisory_xact_lock')) continue;

        const lines = source.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (!lines[i].includes('SELECT pg_advisory_xact_lock')) continue;
          const context = lines.slice(Math.max(0, i - 2), i + 1).join('\n');
          const usesRewrittenQueryRaw = context.includes('$queryRawUnsafe');
          const usesExecuteRawWithoutRowDecoding = context.includes('$executeRaw');
          if (!usesRewrittenQueryRaw && !usesExecuteRawWithoutRowDecoding) {
            offending.push(`${path.relative(process.cwd(), full)}:${i + 1}`);
          }
        }
      }
    };

    visit(root);
    expect(offending).toEqual([]);
  });
});