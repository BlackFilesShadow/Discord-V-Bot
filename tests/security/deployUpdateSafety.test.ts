import fs from 'fs';
import path from 'path';

describe('deploy/update.sh fail-closed invariants', () => {
  const script = fs.readFileSync(path.join(process.cwd(), 'deploy', 'update.sh'), 'utf8');
  const smoke = fs.readFileSync(path.join(process.cwd(), 'deploy', 'smoke.sh'), 'utf8');

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

  it('erkennt den Discord-Login ueber einen stabilen Marker ohne pipefail-SIGPIPE-Risiko', () => {
    expect(script).toContain('LOGIN_LOGS=$(docker compose logs --tail=160 "$COMPOSE_SERVICE" 2>/dev/null || true)');
    expect(script).toContain('grep -Fq "eingeloggt als" <<<"$LOGIN_LOGS"');
    expect(script).not.toContain('| grep -q "eingeloggt als"');
    expect(script).not.toContain('grep -q "Bot eingeloggt als"');
    expect(script).not.toContain('grep -q "V-Bot Prime eingeloggt als"');
  });

  it('fuehrt den internen Live-Smoke erst nach Login und Post-Start-Prisma als hartes Gate aus', () => {
    const login = script.indexOf('Discord-Login bestaetigt.');
    const postStart = script.indexOf('Post-Start Prisma-Status sauber.');
    const smokeRun = script.indexOf('bash "$BOT_DIR/deploy/smoke.sh" "$SMOKE_BASE_URL"');
    const containerStatus = script.indexOf('Container-/Restart-Status:');
    expect(login).toBeGreaterThan(-1);
    expect(postStart).toBeGreaterThan(login);
    expect(smokeRun).toBeGreaterThan(postStart);
    expect(containerStatus).toBeGreaterThan(smokeRun);
    expect(script).toContain('Live-Smoke-Test fehlgeschlagen. Deployment nicht freigegeben.');
  });

  it('deckt Dashboard-SPA sowie DEV- und BotAdmin-Auth-Gates im Live-Smoke ab', () => {
    expect(smoke).toContain('assert_status GET  /                                      200 "Dashboard-SPA"');
    expect(smoke).toContain('assert_status GET  /api/v2/dev/status/system              401 "Dev-Status ohne Login"');
    expect(smoke).toContain('assert_status GET  /api/v2/bot-admin/command-catalog      401 "BotAdmin-Katalog ohne Login"');
    expect(smoke).toContain('assert_status GET  /api/health/discord                    200 "Discord-Health public"');
  });

  it('behandelt SQL-, Health-, Discord-Login-, Live-Smoke- und Post-Start-Migrationsfehler als harte Gates', () => {
    expect(script).toContain('SQL fehlgeschlagen: $name. Deployment abgebrochen.');
    expect(script).toContain('Container wurde innerhalb von 90s nicht healthy.');
    expect(script).toContain('Discord-Login wurde innerhalb von 60s nicht bestaetigt.');
    expect(script).toContain('Post-Start Prisma-Status ist nicht sauber.');
    expect(script).toContain('Live-Smoke-Test fehlgeschlagen. Deployment nicht freigegeben.');
  });
});
