import fs from 'fs';
import path from 'path';

describe('deploy/update.sh fail-closed invariants', () => {
  const script = fs.readFileSync(path.join(process.cwd(), 'deploy', 'update.sh'), 'utf8');

  it('validiert Compose vor Build/Deployment', () => {
    expect(script).toContain('docker compose config --quiet');
    expect(script.indexOf('docker compose config --quiet')).toBeLessThan(script.indexOf('docker compose build "$COMPOSE_SERVICE"'));
  });

  it('adoptiert eine bestehende Baseline niemals implizit', () => {
    expect(script).toContain('ALLOW_BASELINE_ADOPTION');
    expect(script).toContain('Schema-Sentinels');
    expect(script).toContain("table_name='IdempotencyKey' AND column_name='hash'");
    expect(script).not.toContain('Baseline-Adoption fehlgeschlagen - bitte manuell pruefen');
  });

  it('migriert und prueft den Status vor dem Bot-Start', () => {
    const deploy = script.indexOf('npx prisma migrate deploy');
    const status = script.indexOf('npx prisma migrate status');
    const start = script.indexOf('docker compose up -d "$COMPOSE_SERVICE"');
    expect(deploy).toBeGreaterThan(-1);
    expect(status).toBeGreaterThan(deploy);
    expect(start).toBeGreaterThan(status);
  });

  it('behandelt SQL-, Health-, Discord-Login- und Post-Start-Migrationsfehler als harte Gates', () => {
    expect(script).toContain('SQL fehlgeschlagen: $name. Deployment abgebrochen.');
    expect(script).toContain('Container wurde innerhalb von 90s nicht healthy.');
    expect(script).toContain('Discord-Login wurde innerhalb von 60s nicht bestaetigt.');
    expect(script).toContain('Post-Start Prisma-Status ist nicht sauber.');
  });
});
