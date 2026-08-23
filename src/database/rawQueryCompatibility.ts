const VOID_ADVISORY_XACT_LOCK_SELECT = /^\s*SELECT\s+pg_advisory_xact_lock(?:_shared)?\s*\(/i;

/**
 * Prisma's PostgreSQL driver adapter cannot deserialize PostgreSQL's `void`
 * pseudo-type. `pg_advisory_xact_lock*()` intentionally returns `void`, so a
 * direct `$queryRawUnsafe('SELECT pg_advisory_xact_lock(...)')` can acquire the
 * lock successfully in PostgreSQL and still fail afterwards with P2010 while
 * decoding the result row.
 *
 * Keep the lock call inside the SAME raw query / transaction, but expose only a
 * supported INT4 column to Prisma. The CTE contains the volatile lock function
 * and the outer SELECT returns a scalar integer, so transaction semantics and
 * parameter binding are unchanged while no `void` column reaches Prisma.
 */
export function rewritePrismaVoidRawQueryArgs<T>(operation: string, args: T): T {
  if (operation !== '$queryRawUnsafe' || !Array.isArray(args) || typeof args[0] !== 'string') {
    return args;
  }

  const originalSql = args[0];
  if (!VOID_ADVISORY_XACT_LOCK_SELECT.test(originalSql)) return args;

  const sqlWithoutTrailingSemicolon = originalSql.trim().replace(/;\s*$/, '');
  const rewrittenSql =
    `WITH "__vbot_advisory_lock" AS (${sqlWithoutTrailingSemicolon}) ` +
    'SELECT 1::int AS "locked" FROM "__vbot_advisory_lock"';

  return [rewrittenSql, ...args.slice(1)] as unknown as T;
}
