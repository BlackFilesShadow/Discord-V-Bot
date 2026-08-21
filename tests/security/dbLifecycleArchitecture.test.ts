import fs from 'node:fs';
import path from 'node:path';

describe('DB-4 fresh/upgrade/backup-restore production contract', () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const lifecycle = fs.readFileSync(path.join(repoRoot, 'deploy/db-lifecycle-verify.sh'), 'utf8');
  const backupVerify = fs.readFileSync(path.join(repoRoot, 'deploy/backup-verify.sh'), 'utf8');
  const ci = fs.readFileSync(path.join(repoRoot, '.github/workflows/ci.yml'), 'utf8');
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };

  test('fresh and upgrade paths use production Prisma migrate deploy/status plus DB-3 consistency scan', () => {
    const lifecycleScript = String(packageJson.scripts?.['db:lifecycle'] || '');
    // Windows-safe resolver still must invoke the same shell contract.
    expect(lifecycleScript).toContain('deploy/db-lifecycle-verify.sh');
    expect(lifecycleScript.includes('resolve-bash') || lifecycleScript.startsWith('bash ')).toBe(true);
    expect(lifecycle).toContain('npx prisma migrate deploy');
    expect(lifecycle).toContain('npx prisma migrate status');
    expect(lifecycle).toContain('migrate deploy --config');
    expect(lifecycle).toContain('migrate status --config');
    expect(lifecycle).toContain('npm run db:consistency');
    expect(lifecycle).toContain('20260817135600_db2_composite_scope_fks');
    expect(lifecycle).toContain('_DbLifecycleSentinel');
  });

  test('backup/restore is a real pg_dump/pg_restore roundtrip and fails closed', () => {
    expect(lifecycle).toContain('pg_dump --format=custom --no-owner --no-privileges');
    expect(lifecycle).toContain('pg_restore --exit-on-error --no-owner --no-privileges');
    expect(lifecycle).toContain('RESTORE_MIGRATIONS');
    expect(lifecycle).toContain('schema_signature');
    expect(lifecycle).toContain('trap cleanup EXIT');
  });

  test('production backup verifier rejects checksum or restore errors instead of warning and continuing', () => {
    expect(backupVerify).toContain('sha256sum -c');
    expect(backupVerify).toContain('psql -v ON_ERROR_STOP=1');
    expect(backupVerify).not.toContain('ON_ERROR_STOP=0');
    expect(backupVerify).toContain('npm run db:consistency');
    expect(backupVerify).toContain('NOT convalidated');
  });

  test('CI blocks before Jest when lifecycle verification fails', () => {
    const scannerIndex = ci.indexOf('Run DB orphan/consistency scanner');
    const lifecycleIndex = ci.indexOf('Verify fresh/upgrade/backup-restore database lifecycle');
    const jestIndex = ci.indexOf('Run tests (no forceExit; leaked handles fail)');

    expect(scannerIndex).toBeGreaterThan(-1);
    expect(lifecycleIndex).toBeGreaterThan(scannerIndex);
    expect(jestIndex).toBeGreaterThan(lifecycleIndex);
    expect(ci).toContain('run: npm run db:lifecycle');
  });
});
