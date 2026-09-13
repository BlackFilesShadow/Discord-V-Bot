#!/usr/bin/env bash
# V-Bot collect-all audit runner.
# Runs only inside the isolated audit environment created by audit-collect-all-docker.sh.
# It deliberately does NOT use `set -e`: independent checks continue after failures.
set -u
set -o pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${AUDIT_OUTPUT_DIR:-/audit-output}"
mkdir -p "$OUT/logs"
SUMMARY="$OUT/summary.tsv"
FAILURES="$OUT/failures.txt"
WARNINGS="$OUT/warnings.txt"
JSON="$OUT/summary.json"
: > "$SUMMARY"
: > "$FAILURES"
: > "$WARNINGS"
printf 'step\tstatus\tclassification\texitCode\twarningLines\tdurationSec\tlog\n' > "$SUMMARY"

declare -A STATUS=()
declare -A EXIT_CODE=()

sanitize_field() {
  printf '%s' "$1" | tr '\t\r\n' '   '
}

fatal_environment() {
  local msg="$1"
  printf 'TEST-/UMGEBUNGSFEHLER: %s\n' "$msg" | tee -a "$FAILURES" >&2
  exit 97
}

# Hard safety barrier. The test suite contains migrations, cleanup and synthetic writes.
[[ "${AUDIT_ISOLATED:-}" == "1" ]] || fatal_environment 'AUDIT_ISOLATED=1 fehlt; Ausfuehrung ausserhalb der isolierten Testumgebung verweigert.'
[[ "${NODE_ENV:-}" == "test" ]] || fatal_environment 'NODE_ENV muss exakt test sein.'
[[ -n "${DATABASE_URL:-}" ]] || fatal_environment 'DATABASE_URL fehlt.'
[[ -n "${REDIS_URL:-}" ]] || fatal_environment 'REDIS_URL fehlt.'

node <<'NODE' || exit 97
const db = new URL(process.env.DATABASE_URL);
const redis = new URL(process.env.REDIS_URL);
const dbName = db.pathname.replace(/^\//, '');
if (db.hostname !== 'audit-postgres' || db.port !== '5432' || dbName !== 'discord_v_bot_audit') {
  console.error(`TEST-/UMGEBUNGSFEHLER: Unsichere DATABASE_URL verweigert (${db.hostname}:${db.port}/${dbName}).`);
  process.exit(1);
}
if (redis.hostname !== 'audit-redis' || (redis.port && redis.port !== '6379')) {
  console.error(`TEST-/UMGEBUNGSFEHLER: Unsichere REDIS_URL verweigert (${redis.hostname}:${redis.port || '6379'}).`);
  process.exit(1);
}
NODE
[[ $? -eq 0 ]] || fatal_environment 'Safety-Check fuer isolierte Datenservices fehlgeschlagen.'

cd "$ROOT" || fatal_environment 'Repository-Root nicht erreichbar.'
SHA="$(git rev-parse HEAD 2>/dev/null || true)"
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || fatal_environment 'Git HEAD ist kein voller Commit-SHA.'
printf 'AUDIT_SHA=%s\n' "$SHA" | tee "$OUT/identity.txt"
printf 'STARTED_AT=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" | tee -a "$OUT/identity.txt"

# deps is a comma-separated list of earlier step names. A failed/skipped prerequisite
# causes a FOLGEFEHLER skip but does not stop unrelated checks.
run_step() {
  local name="$1"
  local failure_class="$2"
  local timeout_sec="$3"
  local deps="$4"
  local command="$5"
  local log="$OUT/logs/${name}.log"
  local dep dep_status

  if [[ -n "$deps" ]]; then
    IFS=',' read -r -a dep_list <<< "$deps"
    for dep in "${dep_list[@]}"; do
      dep_status="${STATUS[$dep]:-MISSING}"
      if [[ "$dep_status" != "PASS" ]]; then
        STATUS["$name"]="SKIPPED"
        EXIT_CODE["$name"]="-"
        printf '%s\tSKIPPED\tFOLGEFEHLER\t-\t0\t0\t-\n' "$(sanitize_field "$name")" >> "$SUMMARY"
        printf '[SKIPPED/FOLGEFEHLER] %s: Voraussetzung %s=%s\n' "$name" "$dep" "$dep_status" | tee -a "$FAILURES"
        return 0
      fi
    done
  fi

  printf '\n===== AUDIT STEP: %s =====\n' "$name"
  printf 'CMD: %s\n' "$command"
  local started ended duration rc warning_count
  started="$(date +%s)"
  set +e
  timeout --signal=TERM --kill-after=30s "${timeout_sec}s" bash -lc "cd '$ROOT' && $command" 2>&1 | tee "$log"
  rc=${PIPESTATUS[0]}
  set -u
  set -o pipefail
  ended="$(date +%s)"
  duration=$((ended - started))

  warning_count="$(grep -Eic '(^|[^[:alpha:]])(warn(ing)?|deprecated|deprecation|advisory)([^[:alpha:]]|$)' "$log" 2>/dev/null || true)"
  if [[ "$warning_count" -gt 0 ]]; then
    {
      printf '\n===== %s (%s warning-like lines; Kontextpruefung erforderlich) =====\n' "$name" "$warning_count"
      grep -Ein '(^|[^[:alpha:]])(warn(ing)?|deprecated|deprecation|advisory)([^[:alpha:]]|$)' "$log" || true
    } >> "$WARNINGS"
  fi

  if [[ "$rc" -eq 0 ]]; then
    STATUS["$name"]="PASS"
    EXIT_CODE["$name"]="0"
    printf '%s\tPASS\tOK\t0\t%s\t%s\t%s\n' \
      "$(sanitize_field "$name")" "$warning_count" "$duration" "$(sanitize_field "$log")" >> "$SUMMARY"
    printf '✅ PASS: %s (warnings-like=%s, %ss)\n' "$name" "$warning_count" "$duration"
  else
    STATUS["$name"]="FAIL"
    EXIT_CODE["$name"]="$rc"
    printf '%s\tFAIL\t%s\t%s\t%s\t%s\t%s\n' \
      "$(sanitize_field "$name")" "$(sanitize_field "$failure_class")" "$rc" "$warning_count" "$duration" "$(sanitize_field "$log")" >> "$SUMMARY"
    {
      printf '\n===== FAIL: %s | class=%s | exit=%s =====\n' "$name" "$failure_class" "$rc"
      tail -n 160 "$log" || true
    } >> "$FAILURES"
    printf '❌ FAIL: %s | %s | exit=%s\n' "$name" "$failure_class" "$rc"
  fi
}

# Environment/tool prerequisites. Failure here blocks only dependent checks.
run_step 'root-npm-ci' 'TEST-/UMGEBUNGSFEHLER' 600 '' 'npm ci'
run_step 'dashboard-npm-ci' 'TEST-/UMGEBUNGSFEHLER' 600 '' 'cd dashboard-ui && npm ci'
run_step 'prisma-generate' 'TEST-/UMGEBUNGSFEHLER' 180 'root-npm-ci' 'npx prisma generate'
run_step 'prisma-validate' 'ECHTER FEHLER' 120 'root-npm-ci' 'npx prisma validate'
run_step 'postgres-client' 'TEST-/UMGEBUNGSFEHLER' 60 '' 'command -v psql && command -v pg_dump && command -v pg_restore && psql --version && pg_dump --version'
run_step 'redis-live' 'TEST-/UMGEBUNGSFEHLER' 60 '' "node -e \"const {createClient}=require('redis');(async()=>{const c=createClient({url:process.env.REDIS_URL});await c.connect();const p=await c.ping();await c.quit();if(p!=='PONG')process.exit(2)})().catch(e=>{console.error(e);process.exit(1)})\""

# Static/schema/build checks.
run_step 'lint-all' 'ECHTER FEHLER' 420 'root-npm-ci,dashboard-npm-ci' 'npm run lint:all'
run_step 'build' 'ECHTER FEHLER' 720 'root-npm-ci,dashboard-npm-ci,prisma-generate' 'npm run build'
run_step 'audit-artifacts' 'ECHTER FEHLER' 120 'root-npm-ci' 'npm run audit:check'
run_step 'radar-assets' 'TEST-/UMGEBUNGSFEHLER' 300 'root-npm-ci' 'npm run radar:assets:verify'

# Isolated database lifecycle. These URLs are already hard-pinned by the safety barrier.
run_step 'db-migrate-deploy' 'ECHTER FEHLER' 240 'prisma-generate' 'npx prisma migrate deploy'
run_step 'db-migrate-status' 'ECHTER FEHLER' 120 'db-migrate-deploy' 'npx prisma migrate status'
run_step 'db-consistency' 'ECHTER FEHLER' 240 'db-migrate-deploy' 'npm run db:consistency'
run_step 'db-lifecycle' 'ECHTER FEHLER' 600 'db-migrate-deploy,postgres-client' 'npm run db:lifecycle'

# Performance/runtime contracts used by the canonical CI.
run_step 'perf-baselines-46-48' 'ECHTER FEHLER' 300 'root-npm-ci' 'WRITE_PERF_ARTIFACTS=0 npm run perf:baselines-46-48'
run_step 'perf-series-46-49' 'ECHTER FEHLER' 300 'root-npm-ci' 'WRITE_PERF_ARTIFACTS=0 npm run perf:series-46-49'
run_step 'stage47-data-plane' 'ECHTER FEHLER' 300 'db-migrate-deploy,redis-live' "STAGE47_REQUIRE_LIVE=1 STAGE47_EXACT_SHA='$SHA' STAGE47_OUTPUT_PATH='$OUT/stage47.json' npm run perf:data-plane-47"
run_step 'stage48-ai-nitrado' 'ECHTER FEHLER' 300 'root-npm-ci' "STAGE48_REQUIRE_LAB=1 STAGE48_EXACT_SHA='$SHA' STAGE48_OUTPUT_PATH='$OUT/stage48.json' npm run perf:ai-nitrado-48"
run_step 'stage50-full-stack-load' 'ECHTER FEHLER' 420 'db-migrate-deploy' "STAGE50_REQUIRE_LIVE=1 STAGE50_EXACT_SHA='$SHA' STAGE50_OUTPUT_PATH='$OUT/stage50.json' npm run perf:load-50"
run_step 'synthetic-load' 'ECHTER FEHLER' 300 'root-npm-ci' 'WRITE_PERF_ARTIFACTS=0 npm run perf:load:synthetic'

# Full Jest corpus and explicit handle pass. They are separate so one does not hide the other.
run_step 'jest-ci' 'ECHTER FEHLER' 720 'root-npm-ci,prisma-generate,db-migrate-deploy' 'npm run test:ci'
run_step 'jest-open-handles' 'ECHTER FEHLER' 720 'root-npm-ci,prisma-generate,db-migrate-deploy' 'npm run test:handles'

# Browser install failures are environment failures; E2E then becomes a Folgefehler.
run_step 'playwright-browser' 'TEST-/UMGEBUNGSFEHLER' 600 'dashboard-npm-ci' 'cd dashboard-ui && npx playwright install --with-deps chromium'
run_step 'playwright-real-db' 'ECHTER FEHLER' 1200 'dashboard-npm-ci,playwright-browser,db-migrate-deploy' "cd dashboard-ui && CI=true E2E_REAL_DB=1 E2E_PORT=4173 DASHBOARD_URL=http://localhost:3000 OAUTH2_REDIRECT_URI=http://localhost:3000/auth/callback npm run e2e"

# Remaining bounded local stress/chaos checks. Real PostgreSQL/Redis process-kill chaos is
# intentionally NOT run here: the runner has no Docker socket. Stage 59 CI owns that proof.
run_step 'soak-smoke' 'ECHTER FEHLER' 300 'root-npm-ci' 'WRITE_PERF_ARTIFACTS=0 npm run perf:soak'
run_step 'structural-chaos' 'ECHTER FEHLER' 300 'root-npm-ci,build' 'WRITE_PERF_ARTIFACTS=0 npm run perf:chaos'
run_step 'players-4000' 'ECHTER FEHLER' 600 'db-migrate-deploy' 'npm run perf:players-4000'

# Dependency/security audits continue independently of runtime-test failures.
run_step 'root-audit-critical' 'ECHTER FEHLER' 180 'root-npm-ci' 'npm audit --audit-level=critical'
run_step 'root-audit-high' 'ECHTER FEHLER' 180 'root-npm-ci' 'npm audit --audit-level=high'
run_step 'root-audit-prod-high' 'ECHTER FEHLER' 180 'root-npm-ci' 'npm audit --omit=dev --audit-level=high'
run_step 'dashboard-audit-prod-high' 'ECHTER FEHLER' 180 'dashboard-npm-ci' 'cd dashboard-ui && npm audit --omit=dev --audit-level=high'
run_step 'dashboard-audit-critical' 'ECHTER FEHLER' 180 'dashboard-npm-ci' 'cd dashboard-ui && npm audit --audit-level=critical'
run_step 'dashboard-audit-high' 'ECHTER FEHLER' 180 'dashboard-npm-ci' 'cd dashboard-ui && npm audit --audit-level=high'

# Convert the machine-readable TSV to JSON without requiring jq.
node "$ROOT/scripts/audit-summary-from-tsv.mjs" "$SUMMARY" "$JSON" "$SHA"
json_rc=$?
if [[ "$json_rc" -ne 0 ]]; then
  printf 'TEST-/UMGEBUNGSFEHLER: summary.json konnte nicht erzeugt werden (exit=%s).\n' "$json_rc" >> "$FAILURES"
fi

failed=0
skipped=0
while IFS=$'\t' read -r step status class exit_code warning_lines duration log; do
  [[ "$step" == 'step' ]] && continue
  [[ "$status" == 'FAIL' ]] && failed=$((failed + 1))
  [[ "$status" == 'SKIPPED' ]] && skipped=$((skipped + 1))
done < "$SUMMARY"

{
  printf 'FINISHED_AT=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'FAILED_BLOCKS=%s\n' "$failed"
  printf 'SKIPPED_FOLGEBLOCKS=%s\n' "$skipped"
  printf 'NOTE=Warning-like lines are raw candidates and require context; they do not fail a green block.\n'
  printf 'NOTE=Real Stage59 PostgreSQL/Redis process-kill, Gitleaks and Trivy remain canonical GitHub-CI evidence and are not executed through this no-Docker-socket runner.\n'
} | tee -a "$OUT/identity.txt"

printf '\n===== FINAL BLOCK SUMMARY =====\n'
column -t -s $'\t' "$SUMMARY" 2>/dev/null || cat "$SUMMARY"
printf '\nArtifacts: %s\n' "$OUT"

if [[ "$failed" -gt 0 ]]; then
  exit 1
fi
exit 0
