import fs from 'fs';
import path from 'path';

describe('deploy/update.sh fail-closed invariants', () => {
  const script = fs.readFileSync(path.join(process.cwd(), 'deploy', 'update.sh'), 'utf8');

  it('validiert Compose sowohl vor als auch nach dem neuen Checkout', () => {
    const configChecks = script.match(/docker compose config --quiet/g) ?? [];
    expect(configChecks).toHaveLength(2);
    const reset = script.indexOf('git reset --hard origin/main');
    const first = script.indexOf('docker compose config --quiet');
    const second = script.indexOf('docker compose config --quiet', first + 1);
    const build = script.indexOf('docker compose build "$COMPOSE_SERVICE"');
    expect(first).toBeLessThan(reset);
    expect(second).toBeGreaterThan(reset);
    expect(second).toBeLessThan(build);
  });

  it('stellt Postgres vor Baseline-/Sentinel-Abfragen explizit bereit', () => {
    const up = script.indexOf('docker compose up -d postgres');
    const ready = script.indexOf('docker compose exec -T postgres pg_isready');
    const sentinelPhase = script.indexOf('Pruefe Baseline-/Migrationshistorie');
    expect(up).toBeGreaterThan(-1);
    expect(ready).toBeGreaterThan(up);
    expect(sentinelPhase).toBeGreaterThan(ready);
    expect(script).toContain('Postgres wurde innerhalb von 60s nicht bereit.');
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

  it('erkennt den Discord-Login ueber einen stabilen Marker statt eines Produktnamens', () => {
    expect(script).toContain('grep -q "eingeloggt als"');
    expect(script).not.toContain('grep -q "Bot eingeloggt als"');
    expect(script).not.toContain('grep -q "V-Bot Prime eingeloggt als"');
  });

  it('behandelt SQL-, Health-, Discord-Login- und Post-Start-Migrationsfehler als harte Gates', () => {
    expect(script).toContain('SQL fehlgeschlagen: $name. Deployment abgebrochen.');
    expect(script).toContain('Container wurde innerhalb von 90s nicht healthy.');
    expect(script).toContain('Discord-Login wurde innerhalb von 60s nicht bestaetigt.');
    expect(script).toContain('Post-Start Prisma-Status ist nicht sauber.');
  });
});
