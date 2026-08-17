import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '../..');
const scanner = fs.readFileSync(path.join(repoRoot, 'src/database/consistencyScanner.ts'), 'utf8');
const cli = fs.readFileSync(path.join(repoRoot, 'src/scripts/dbConsistencyScan.ts'), 'utf8');
const packageJson = fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8');
const ci = fs.readFileSync(path.join(repoRoot, '.github/workflows/ci.yml'), 'utf8');

describe('DB-3 orphan and consistency scanner architecture', () => {
  test('discovers actual PostgreSQL FKs and all direct Guild+Gameserver tables instead of maintaining a fragile partial list', () => {
    expect(scanner).toContain('FROM pg_constraint');
    expect(scanner).toContain("con.contype = 'f'");
    expect(scanner).toContain('information_schema.columns');
    expect(scanner).toContain("column_name IN ('guildId', 'nitradoConnId')");
    expect(scanner).toContain('NitradoConnection');
  });

  test('covers semantic invariants that ordinary foreign keys cannot fully express', () => {
    expect(scanner).toContain('GAME_IDENTITY_VERIFIED_INCOMPLETE');
    expect(scanner).toContain('PLAYER_SESSION_CONNECT_EVENT_SCOPE');
    expect(scanner).toContain('PLAYER_SESSION_DISCONNECT_EVENT_SCOPE');
    expect(scanner).toContain('ECONOMY_MIGRATION_REQUIRED');
    expect(scanner).toContain('ECONOMY_RESOLVED_NULL_SCOPE');
    expect(scanner).toContain('CASINO_ROUND_SCOPE_DIVERGENCE');
  });

  test('scanner is diagnosis-only and cannot silently mutate production truth', () => {
    expect(scanner).not.toMatch(/\b(?:UPDATE|DELETE|INSERT|ALTER|DROP|TRUNCATE)\s+/i);
    expect(scanner).not.toContain('.delete(');
    expect(scanner).not.toContain('.deleteMany(');
    expect(scanner).not.toContain('.update(');
    expect(scanner).not.toContain('.updateMany(');
    expect(scanner).not.toContain('.create(');
    expect(scanner).not.toContain('.createMany(');
  });

  test('production command is CI-blocking after migrations and before Jest', () => {
    expect(packageJson).toContain('"db:consistency": "ts-node src/scripts/dbConsistencyScan.ts"');
    expect(cli).toContain("report.status === 'INVALID'");
    expect(cli).toContain('process.exitCode = 2');

    const migrate = ci.indexOf('Run database migrations (production path)');
    const scan = ci.indexOf('Run DB orphan/consistency scanner');
    const jest = ci.indexOf('Run tests (no forceExit; leaked handles fail)');
    expect(migrate).toBeGreaterThanOrEqual(0);
    expect(scan).toBeGreaterThan(migrate);
    expect(jest).toBeGreaterThan(scan);
  });
});
