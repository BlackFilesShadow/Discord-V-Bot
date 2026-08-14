#!/bin/bash
# =============================================
# Discord-V-Bot - Update Script (Docker-Workflow)
# Pull -> Build -> sichere DB-Migration -> Start -> Health/Login/Drift-Gates
# =============================================
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

BOT_DIR="${BOT_DIR:-/opt/discord-v-bot}"
COMPOSE_SERVICE="bot"
CONTAINER_NAME="discord-v-bot"

log()  { echo -e "${GREEN}[\u2713]${NC} $1"; }
info() { echo -e "${BLUE}[i]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[\u2717]${NC} $1"; exit 1; }

if [[ $EUID -ne 0 ]]; then
  err "Bitte als root ausfuehren: sudo bash update.sh"
fi

cd "$BOT_DIR" || err "BOT_DIR nicht gefunden: $BOT_DIR"

git config --global --add safe.directory "$BOT_DIR" >/dev/null 2>&1 || true

info "Discord-V-Bot Update gestartet ($BOT_DIR)"

# 0) Compose/.env VOR jeder Aenderung validieren. So wird bei fehlenden
#    Pflichtvariablen oder ungueltiger Compose-Datei nichts halb deployed.
info "Docker-Compose-Konfiguration wird validiert..."
docker compose config --quiet || err "docker compose config fehlgeschlagen. .env/Compose pruefen."
log "Compose-Konfiguration gueltig."

# 1) Code ziehen
info "Git fetch + reset auf origin/main..."
OLD_COMMIT=$(git rev-parse --short HEAD || echo "unknown")
git fetch origin main
git reset --hard origin/main
NEW_COMMIT=$(git rev-parse --short HEAD)

if [[ "$OLD_COMMIT" == "$NEW_COMMIT" ]]; then
  log "Bereits auf dem neuesten Stand ($OLD_COMMIT)"
  read -r -p "Trotzdem rebuild + restart? [y/N] " yn
  if [[ ! "$yn" =~ ^[Yy]$ ]]; then exit 0; fi
else
  info "Update: $OLD_COMMIT -> $NEW_COMMIT"
fi

git --no-pager log --oneline "$OLD_COMMIT..$NEW_COMMIT" 2>/dev/null | head -10 || true

# 2) Image bauen (noch NICHT starten).
info "Docker-Image wird gebaut..."
docker compose build "$COMPOSE_SERVICE" || err "Docker-Build fehlgeschlagen."

# 3) Baseline-Adoption VOR dem Containerstart.
#
# SICHERHEITSREGEL:
# Eine bestehende DB ohne Baseline-Eintrag wird NIE mehr allein aufgrund einer
# einzelnen vorhandenen Tabelle als kompatibel angenommen. Automatische
# Baseline-Adoption ist nur erlaubt, wenn der Operator sie fuer GENAU dieses
# Deployment explizit mit ALLOW_BASELINE_ADOPTION=true freigibt UND mehrere
# unabhaengige Schema-Sentinels vorhanden sind. Ansonsten fail-closed.
info "Pruefe Baseline-/Migrationshistorie..."
BASELINE_MIGRATION="00000000000000_baseline"
PGU="${POSTGRES_USER:-discordbot}"
PGD="${POSTGRES_DB:-discord_v_bot}"
SCHEMA_PRESENT=$(docker compose exec -T postgres psql -U "$PGU" -d "$PGD" -tAc \
  "SELECT to_regclass('public.\"User\"') IS NOT NULL;" 2>/dev/null | tr -d '[:space:]')
HISTORY_TABLE=$(docker compose exec -T postgres psql -U "$PGU" -d "$PGD" -tAc \
  "SELECT to_regclass('public._prisma_migrations') IS NOT NULL;" 2>/dev/null | tr -d '[:space:]')
BASELINE_APPLIED="f"
if [[ "$HISTORY_TABLE" == "t" ]]; then
  BASELINE_APPLIED=$(docker compose exec -T postgres psql -U "$PGU" -d "$PGD" -tAc \
    "SELECT EXISTS(SELECT 1 FROM public._prisma_migrations WHERE migration_name='$BASELINE_MIGRATION' AND finished_at IS NOT NULL AND rolled_back_at IS NULL);" 2>/dev/null | tr -d '[:space:]')
fi

if [[ "$SCHEMA_PRESENT" == "t" && "$BASELINE_APPLIED" != "t" ]]; then
  warn "Bestehendes Schema ohne angewendete Prisma-Baseline erkannt."

  if [[ "${ALLOW_BASELINE_ADOPTION:-false}" != "true" ]]; then
    err "Baseline-Adoption ist fail-closed. Nach manueller DB-Pruefung fuer einen einzelnen Lauf ALLOW_BASELINE_ADOPTION=true setzen."
  fi

  info "Explizites Baseline-Opt-in erkannt; pruefe Schema-Sentinels..."
  SENTINEL_OK=$(docker compose exec -T postgres psql -U "$PGU" -d "$PGD" -tAc \
    "SELECT
       to_regclass('public.\"User\"') IS NOT NULL
       AND to_regclass('public.\"Package\"') IS NOT NULL
       AND to_regclass('public.\"Upload\"') IS NOT NULL
       AND to_regclass('public.\"AuditLog\"') IS NOT NULL
       AND to_regclass('public.\"NitradoConnection\"') IS NOT NULL
       AND to_regclass('public.\"IdempotencyKey\"') IS NOT NULL
       AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='NitradoConnection' AND column_name='guildId')
       AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='NitradoConnection' AND column_name='encryptedToken')
       AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='IdempotencyKey' AND column_name='hash');" \
    2>/dev/null | tr -d '[:space:]')

  if [[ "$SENTINEL_OK" != "t" ]]; then
    err "Schema-Sentinels passen nicht zur erwarteten Legacy/Baseline-Struktur. Keine Baseline-Adoption; DB manuell untersuchen."
  fi

  info "Schema-Sentinels gueltig; adoptiere Baseline einmalig..."
  docker compose run --rm "$COMPOSE_SERVICE" npx prisma migrate resolve --applied "$BASELINE_MIGRATION" \
    || err "Baseline-Adoption fehlgeschlagen. Deployment abgebrochen."
  log "Baseline explizit und erfolgreich adoptiert."
fi

# Eine leere DB wird NICHT resolved; migrate deploy erzeugt sie regulaer.

# 4) Migrationen VOR dem eigentlichen Bot-Start auf einem Einmal-Container
#    anwenden. So startet nie eine neue App-Version gegen ein ungeprueftes Schema.
info "Prisma-Migrationen werden angewendet..."
docker compose run --rm "$COMPOSE_SERVICE" npx prisma migrate deploy \
  || err "Prisma migrate deploy fehlgeschlagen. Bot wird nicht gestartet."
log "Prisma migrate deploy erfolgreich."

info "Prisma-Migrationsstatus wird verifiziert..."
docker compose run --rm "$COMPOSE_SERVICE" npx prisma migrate status \
  || err "Prisma migrate status meldet Pending/Fehler. Deployment abgebrochen."
log "Prisma-Migrationsstatus sauber."

# 4a) Zusaetzliche idempotente SQL-Skripte. Auch diese sind jetzt ein hartes
#     Gate: ein partiell angewendetes Deployment ist gefaehrlicher als Abbruch.
SQL_DIR="$(cd "$(dirname "$0")" && pwd)/sql"
if [[ -d "$SQL_DIR" ]]; then
  shopt -s nullglob
  SQL_FILES=("$SQL_DIR"/*.sql)
  shopt -u nullglob
  if (( ${#SQL_FILES[@]} > 0 )); then
    info "Wende ${#SQL_FILES[@]} SQL-Skript(e) aus deploy/sql/ an..."
    for f in "${SQL_FILES[@]}"; do
      name="$(basename "$f")"
      docker compose exec -T postgres psql -U "$PGU" -d "$PGD" -v ON_ERROR_STOP=1 < "$f" >/dev/null \
        || err "SQL fehlgeschlagen: $name. Deployment abgebrochen."
      log "SQL angewendet: $name"
    done
  fi
fi

# 5) Bot erst NACH erfolgreichem DB-Gate starten.
info "Bot-Container wird gestartet..."
docker compose up -d "$COMPOSE_SERVICE" || err "docker compose up fehlgeschlagen."

info "Warte auf Container-Health..."
HEALTH_OK=0
for i in {1..45}; do
  STATUS=$(docker inspect --format='{{.State.Health.Status}}' "$CONTAINER_NAME" 2>/dev/null || echo "starting")
  if [[ "$STATUS" == "healthy" ]]; then
    HEALTH_OK=1
    log "Container ist healthy."
    break
  fi
  if [[ "$STATUS" == "unhealthy" ]]; then
    docker compose logs --tail=80 "$COMPOSE_SERVICE" || true
    err "Container wurde unhealthy nach Update."
  fi
  sleep 2
done
if [[ "$HEALTH_OK" -ne 1 ]]; then
  docker compose logs --tail=80 "$COMPOSE_SERVICE" || true
  err "Container wurde innerhalb von 90s nicht healthy."
fi

# 6) Discord-Login ist ebenfalls ein hartes Gate. Health allein beweist nicht,
#    dass der Bot mit Discord verbunden ist.
info "Pruefe Discord-Login..."
LOGIN_OK=0
for i in {1..30}; do
  if docker compose logs --tail=160 "$COMPOSE_SERVICE" 2>/dev/null | grep -q "Bot eingeloggt als"; then
    LOGIN_OK=1
    break
  fi
  sleep 2
done
if [[ "$LOGIN_OK" -ne 1 ]]; then
  docker compose logs --tail=120 "$COMPOSE_SERVICE" || true
  err "Discord-Login wurde innerhalb von 60s nicht bestaetigt."
fi
log "Discord-Login bestaetigt."

# 7) Nach dem Start migrationsseitig erneut read-only verifizieren.
info "Post-Start Migration-Drift/Pending-Check..."
docker compose exec -T "$COMPOSE_SERVICE" npx prisma migrate status \
  || err "Post-Start Prisma-Status ist nicht sauber."
log "Post-Start Prisma-Status sauber."

# 8) Prozess-/Container-Hygiene.
info "Container-/Restart-Status:"
docker compose ps "$COMPOSE_SERVICE"
RESTART_COUNT=$(docker inspect --format='{{.RestartCount}}' "$CONTAINER_NAME" 2>/dev/null || echo "unknown")
if [[ "$RESTART_COUNT" != "0" ]]; then
  warn "Container RestartCount=$RESTART_COUNT. Logs vor Freigabe pruefen."
fi

info "Letzte Bot-Logs:"
docker compose logs --tail=40 "$COMPOSE_SERVICE" | tail -50

log "Update erfolgreich. Bot laeuft auf Commit $NEW_COMMIT."
