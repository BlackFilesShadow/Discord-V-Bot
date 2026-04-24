#!/bin/bash
# =============================================
# Discord-V-Bot - Update Script (Docker-Workflow)
# Pull -> Rebuild Container -> DB-Schema-Sync -> Status
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

# Git safe.directory (root <-> repo-owner mismatch)
git config --global --add safe.directory "$BOT_DIR" >/dev/null 2>&1 || true

info "Discord-V-Bot Update gestartet ($BOT_DIR)"

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

# 2) Container neu bauen + starten
info "Docker-Image wird gebaut und Container neu gestartet..."
docker compose up -d --build "$COMPOSE_SERVICE"

# 3) Auf Health warten
info "Warte auf Container-Health..."
for i in {1..30}; do
  STATUS=$(docker inspect --format='{{.State.Health.Status}}' "$CONTAINER_NAME" 2>/dev/null || echo "starting")
  if [[ "$STATUS" == "healthy" ]]; then
    log "Container ist healthy."
    break
  fi
  if [[ "$STATUS" == "unhealthy" ]]; then
    docker compose logs --tail=40 "$COMPOSE_SERVICE"
    err "Container wurde unhealthy nach Update."
  fi
  sleep 2
done

# 4) DB-Schema synchronisieren
info "Prisma-Schema wird gegen DB gepusht..."
if docker compose exec -T "$COMPOSE_SERVICE" npx prisma db push --skip-generate --accept-data-loss; then
  log "DB-Schema synchronisiert."
else
  warn "Prisma db push lieferte Fehler - bitte Logs pruefen."
fi

# 4b) Zusaetzliche idempotente SQL-Skripte (deploy/sql/*.sql) anwenden.
#     Erlaubt additive Indices/Extensions ohne Prisma-Schema-Aenderung.
SQL_DIR="$(cd "$(dirname "$0")" && pwd)/sql"
if [[ -d "$SQL_DIR" ]]; then
  shopt -s nullglob
  SQL_FILES=("$SQL_DIR"/*.sql)
  shopt -u nullglob
  if (( ${#SQL_FILES[@]} > 0 )); then
    info "Wende ${#SQL_FILES[@]} SQL-Skript(e) aus deploy/sql/ an..."
    for f in "${SQL_FILES[@]}"; do
      name="$(basename "$f")"
      if docker compose exec -T postgres psql -U "${POSTGRES_USER:-discordbot}" -d "${POSTGRES_DB:-discord_v_bot}" -v ON_ERROR_STOP=1 < "$f" >/dev/null 2>&1; then
        log "SQL angewendet: $name"
      else
        warn "SQL fehlgeschlagen: $name (siehe psql-Output)"
      fi
    done
  fi
fi

# 5) Letzte Logs zur Kontrolle
info "Letzte Bot-Logs:"
docker compose logs --tail=20 "$COMPOSE_SERVICE" | tail -25

# 6) Login-Detection: warte bis "Bot eingeloggt" in den Logs auftaucht.
#    Faengt verzoegerte Crashes / Token-Probleme, die der Docker-Healthcheck
#    nicht erkennt (Container "healthy" aber Discord-Login schlug fehl).
info "Pruefe Discord-Login..."
LOGIN_OK=0
for i in {1..15}; do
  if docker compose logs --tail=80 "$COMPOSE_SERVICE" 2>/dev/null | grep -q "Bot eingeloggt als"; then
    LOGIN_OK=1
    break
  fi
  sleep 2
done

if [[ "$LOGIN_OK" -eq 1 ]]; then
  log "Discord-Login bestaetigt."
else
  warn "Kein 'Bot eingeloggt'-Log innerhalb von 30s gefunden \u2013 bitte 'docker compose logs $COMPOSE_SERVICE' pruefen."
fi

log "Update erfolgreich. Bot laeuft auf Commit $NEW_COMMIT."
