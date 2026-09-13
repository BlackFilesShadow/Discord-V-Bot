#!/usr/bin/env bash
# Host-side wrapper for scripts/audit-collect-all.sh.
# Creates disposable PostgreSQL/Redis services on a private Docker network with NO host ports.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

for tool in docker git awk sed tee mktemp; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "TEST-/UMGEBUNGSFEHLER: benoetigtes Host-Tool fehlt: $tool" >&2
    exit 97
  }
done

docker info >/dev/null 2>&1 || {
  echo 'TEST-/UMGEBUNGSFEHLER: Docker daemon ist nicht erreichbar.' >&2
  exit 97
}

SHA="${AUDIT_SHA:-$(git rev-parse HEAD)}"
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || {
  echo "TEST-/UMGEBUNGSFEHLER: AUDIT_SHA ist kein voller Commit-SHA: $SHA" >&2
  exit 97
}
git cat-file -e "${SHA}^{commit}" 2>/dev/null || {
  echo "TEST-/UMGEBUNGSFEHLER: Commit $SHA ist im lokalen Repository nicht vorhanden." >&2
  exit 97
}

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
SHORT_SHA="${SHA:0:12}"
RUN_ID="${STAMP,,}-$$-$RANDOM"
RUN_ID="${RUN_ID//:/-}"
HOST_OUTPUT_ROOT="${AUDIT_HOST_OUTPUT_ROOT:-/root/vbot-audit-output}"
OUT="$HOST_OUTPUT_ROOT/${STAMP}-${SHORT_SHA}"
WORK="$(mktemp -d "/tmp/vbot-audit-${SHORT_SHA}-XXXXXX")"
REPO_COPY="$WORK/repo"
NETWORK="vbot-audit-${RUN_ID}"
POSTGRES_CONTAINER="vbot-audit-postgres-${RUN_ID}"
REDIS_CONTAINER="vbot-audit-redis-${RUN_ID}"
RUNNER_CONTAINER="vbot-audit-runner-${RUN_ID}"
RUNNER_IMAGE="vbot-audit-runner:${SHORT_SHA}-${RANDOM}"
FULL_LOG="$OUT/full-console.log"
REPORT="$OUT/VBot-FULL-REPO-AUDIT.md"
RUNNER_RC=97

mkdir -p "$OUT"

cleanup() {
  local rc=$?
  docker rm -f "$RUNNER_CONTAINER" >/dev/null 2>&1 || true
  docker rm -f "$POSTGRES_CONTAINER" >/dev/null 2>&1 || true
  docker rm -f "$REDIS_CONTAINER" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
  docker image rm -f "$RUNNER_IMAGE" >/dev/null 2>&1 || true
  rm -rf "$WORK" >/dev/null 2>&1 || true
  return "$rc"
}
trap cleanup EXIT INT TERM

for name in "$POSTGRES_CONTAINER" "$REDIS_CONTAINER" "$RUNNER_CONTAINER"; do
  if docker inspect "$name" >/dev/null 2>&1; then
    echo "TEST-/UMGEBUNGSFEHLER: unerwartete Docker-Namenskollision: $name" >&2
    exit 97
  fi
done

ORIGIN_URL="$(git remote get-url origin 2>/dev/null || true)"
git clone --no-hardlinks --no-checkout "$ROOT" "$REPO_COPY" >/dev/null
if [[ -n "$ORIGIN_URL" ]]; then
  git -C "$REPO_COPY" remote set-url origin "$ORIGIN_URL"
fi
git -C "$REPO_COPY" checkout --detach "$SHA" >/dev/null
ACTUAL_SHA="$(git -C "$REPO_COPY" rev-parse HEAD)"
[[ "$ACTUAL_SHA" == "$SHA" ]] || {
  echo "TEST-/UMGEBUNGSFEHLER: Audit-Kopie steht auf $ACTUAL_SHA statt $SHA." >&2
  exit 97
}

# If Git LFS is available on the host, hydrate the isolated clone. A failure remains visible
# and radar-assets will classify the missing assets as a test/environment problem later.
if git lfs version >/dev/null 2>&1; then
  if ! git -C "$REPO_COPY" lfs pull; then
    echo 'WARNUNG: git lfs pull ist fehlgeschlagen; Asset-Pruefung kann dadurch als TEST-/UMGEBUNGSFEHLER scheitern.' | tee -a "$FULL_LOG"
  fi
else
  echo 'WARNUNG: git-lfs ist auf dem Host nicht installiert; vorhandene lokale LFS-Objekte werden verwendet.' | tee -a "$FULL_LOG"
fi

cat <<EOF | tee -a "$FULL_LOG"
===== V-BOT COLLECT-ALL AUDIT =====
SHA=$SHA
OUTPUT=$OUT
NETWORK=$NETWORK
SAFETY=isolated Docker network, no published PostgreSQL/Redis ports, runner without Docker socket
EOF

docker network create "$NETWORK" >/dev/null

docker run -d \
  --name "$POSTGRES_CONTAINER" \
  --network "$NETWORK" \
  --network-alias audit-postgres \
  -e POSTGRES_USER=audit \
  -e POSTGRES_PASSWORD=auditpass \
  -e POSTGRES_DB=discord_v_bot_audit \
  --health-cmd 'pg_isready -U audit -d discord_v_bot_audit' \
  --health-interval 2s \
  --health-timeout 3s \
  --health-retries 30 \
  pgvector/pgvector:pg16 >/dev/null

docker run -d \
  --name "$REDIS_CONTAINER" \
  --network "$NETWORK" \
  --network-alias audit-redis \
  --health-cmd 'redis-cli ping || exit 1' \
  --health-interval 2s \
  --health-timeout 3s \
  --health-retries 30 \
  redis:7.4-alpine >/dev/null

# Hard proof that neither disposable data service is published on the host.
if [[ -n "$(docker port "$POSTGRES_CONTAINER" 2>/dev/null)" ]] || [[ -n "$(docker port "$REDIS_CONTAINER" 2>/dev/null)" ]]; then
  echo 'TEST-/UMGEBUNGSFEHLER: Audit-Datenservice besitzt unerwartet einen Host-Port; Abbruch.' >&2
  exit 97
fi

wait_healthy() {
  local name="$1"
  local attempts=90
  local state
  for ((i = 1; i <= attempts; i++)); do
    state="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$name" 2>/dev/null || true)"
    if [[ "$state" == 'healthy' ]]; then
      return 0
    fi
    if [[ "$state" == 'unhealthy' ]]; then
      docker logs "$name" 2>&1 | tail -n 120 >&2 || true
      return 1
    fi
    sleep 2
  done
  return 1
}

wait_healthy "$POSTGRES_CONTAINER" || {
  echo 'TEST-/UMGEBUNGSFEHLER: isoliertes PostgreSQL wurde nicht healthy.' >&2
  exit 97
}
wait_healthy "$REDIS_CONTAINER" || {
  echo 'TEST-/UMGEBUNGSFEHLER: isoliertes Redis wurde nicht healthy.' >&2
  exit 97
}

docker build --pull -t "$RUNNER_IMAGE" - <<'DOCKERFILE' >/dev/null
FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash ca-certificates curl git postgresql-client python3 make g++ procps \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
DOCKERFILE

# Build the required 64-character test key at runtime so no secret-like literal is committed.
TEST_ENCRYPTION_KEY="$(printf '%064d' 0)"

set +e
docker run --name "$RUNNER_CONTAINER" \
  --network "$NETWORK" \
  -v "$REPO_COPY:/repo:rw" \
  -v "$OUT:/audit-output:rw" \
  -e AUDIT_ISOLATED=1 \
  -e AUDIT_OUTPUT_DIR=/audit-output \
  -e NODE_ENV=test \
  -e CI=true \
  -e DATABASE_URL=postgresql://audit:auditpass@audit-postgres:5432/discord_v_bot_audit \
  -e REDIS_URL=redis://audit-redis:6379 \
  -e DISCORD_TOKEN=test-token \
  -e DISCORD_CLIENT_ID=test-client-id \
  -e DISCORD_CLIENT_SECRET=test-secret \
  -e BOT_OWNER_ID=123456789012345678 \
  -e ENCRYPTION_KEY="$TEST_ENCRYPTION_KEY" \
  -e SESSION_SECRET=test-session-secret \
  -e DASHBOARD_URL=http://localhost:3000 \
  "$RUNNER_IMAGE" \
  bash scripts/audit-collect-all.sh 2>&1 | tee -a "$FULL_LOG"
RUNNER_RC=${PIPESTATUS[0]}
set -e

make_report() {
  {
    echo '# V-Bot – vollständiger Collect-All Repo-Audit'
    echo
    echo "- **SHA:** \`$SHA\`"
    echo "- **UTC-Lauf:** \`$STAMP\`"
    echo "- **Runner Exit-Code:** \`$RUNNER_RC\`"
    echo '- **Safety:** isolierte Repo-Kopie, privates Docker-Netz, keine PostgreSQL-/Redis-Hostports, kein Docker-Socket im Test-Runner'
    echo

    if [[ -f "$OUT/summary.tsv" ]]; then
      echo '## Block-Zusammenfassung'
      echo
      awk -F '\t' '
        NR == 1 { print "| Schritt | Status | Klassifikation | Exit | Warnhinweise | Dauer (s) |"; print "|---|---|---|---:|---:|---:|"; next }
        {
          for (i = 1; i <= NF; i++) gsub(/\|/, "\\|", $i);
          printf "| %s | %s | %s | %s | %s | %s |\n", $1, $2, $3, $4, $5, $6
        }
      ' "$OUT/summary.tsv"
      echo
    fi

    echo '## Fehler / Folgefehler'
    echo
    if [[ -s "$OUT/failures.txt" ]]; then
      echo '~~~~text'
      cat "$OUT/failures.txt"
      echo '~~~~'
    else
      echo 'Keine erfassten Fehlerblöcke.'
    fi
    echo

    echo '## Warnungs-Kandidaten'
    echo
    echo '> Diese Treffer sind bewusst nur Kandidaten. Ein WARN/Deprecated-Text ist nicht automatisch ein echter Fehler und muss im Kontext bewertet werden.'
    echo
    if [[ -s "$OUT/warnings.txt" ]]; then
      echo '~~~~text'
      cat "$OUT/warnings.txt"
      echo '~~~~'
    else
      echo 'Keine warnungsartigen Treffer erfasst.'
    fi
    echo

    echo '## Vollständige Konsolenausgabe'
    echo
    echo '~~~~text'
    cat "$FULL_LOG"
    echo '~~~~'
  } > "$REPORT"
}

make_report

printf '\n===== AUDIT OUTPUT =====\n' | tee -a "$FULL_LOG"
printf 'Report: %s\n' "$REPORT" | tee -a "$FULL_LOG"
printf 'JSON:   %s\n' "$OUT/summary.json" | tee -a "$FULL_LOG"
printf 'TSV:    %s\n' "$OUT/summary.tsv" | tee -a "$FULL_LOG"
printf 'Log:    %s\n' "$FULL_LOG" | tee -a "$FULL_LOG"
printf 'Exit:   %s\n' "$RUNNER_RC" | tee -a "$FULL_LOG"

exit "$RUNNER_RC"
