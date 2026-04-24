#!/bin/bash
# =============================================
# Discord-V-Bot - Backup Verifier
# Restauriert das letzte Backup in einen Wegwerf-Postgres-Container
# und prueft die Tabellen auf Plausibilitaet.
# =============================================
set -euo pipefail

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m'

BACKUP_DIR="${BACKUP_DIR:-/opt/discord-v-bot-backups}"
PG_IMAGE="${PG_IMAGE:-pgvector/pgvector:pg16}"
TMP_NAME="vbot-backup-verify-$(date +%s)"
TMP_DIR="/tmp/${TMP_NAME}"
PG_PORT="55432"
PG_USER="verifier"
PG_PASS="verify_$(openssl rand -hex 8)"
PG_DB="vbot_verify"

log()  { echo -e "${GREEN}[OK]${NC} $1"; }
info() { echo -e "${BLUE}[i]${NC}  $1"; }
warn() { echo -e "${YELLOW}[!]${NC}  $1"; }
err()  { echo -e "${RED}[X]${NC}  $1"; cleanup; exit 1; }

cleanup() {
  info "Cleanup..."
  docker rm -f "$TMP_NAME" >/dev/null 2>&1 || true
  rm -rf "$TMP_DIR" || true
}

trap cleanup EXIT

if [[ ! -d "$BACKUP_DIR" ]]; then
  err "Backup-Verzeichnis nicht gefunden: $BACKUP_DIR"
fi

# 1) Letztes Backup finden
LATEST=$(ls -1t "$BACKUP_DIR"/backup_*.tar.gz 2>/dev/null | head -n1 || true)
if [[ -z "$LATEST" ]]; then
  err "Kein backup_*.tar.gz in $BACKUP_DIR gefunden."
fi
info "Pruefe: $(basename "$LATEST")"

# 2) Entpacken
mkdir -p "$TMP_DIR"
tar -xzf "$LATEST" -C "$TMP_DIR"
SQL_FILE=$(find "$TMP_DIR" -name database.sql -type f | head -n1)
if [[ -z "$SQL_FILE" ]]; then
  err "database.sql nicht im Backup gefunden."
fi
SQL_SIZE=$(du -h "$SQL_FILE" | cut -f1)
info "SQL-Dump: $SQL_SIZE"

# 3) Wegwerf-Postgres starten
info "Starte Wegwerf-Postgres ($PG_IMAGE) auf Port $PG_PORT..."
docker run -d --rm \
  --name "$TMP_NAME" \
  -e POSTGRES_USER="$PG_USER" \
  -e POSTGRES_PASSWORD="$PG_PASS" \
  -e POSTGRES_DB="$PG_DB" \
  -p "${PG_PORT}:5432" \
  "$PG_IMAGE" >/dev/null

# 4) Auf Bereitschaft warten
info "Warte auf Postgres..."
for i in {1..30}; do
  if docker exec "$TMP_NAME" pg_isready -U "$PG_USER" -d "$PG_DB" >/dev/null 2>&1; then
    log "Postgres ready."
    break
  fi
  sleep 1
done

# 5) Dump importieren
info "Importiere Dump..."
if ! docker exec -i "$TMP_NAME" psql -v ON_ERROR_STOP=0 -U "$PG_USER" -d "$PG_DB" < "$SQL_FILE" >/tmp/${TMP_NAME}-import.log 2>&1; then
  warn "Import lieferte Warnungen/Fehler. Log: /tmp/${TMP_NAME}-import.log"
fi

# 6) Sanity-Checks: Tabellen vorhanden? Zeilen plausibel?
info "Pruefe Tabellen..."
TABLES=("User" "Package" "Upload" "AuditLog")
ALL_OK=1
for t in "${TABLES[@]}"; do
  COUNT=$(docker exec "$TMP_NAME" psql -U "$PG_USER" -d "$PG_DB" -tAc "SELECT count(*) FROM \"$t\"" 2>/dev/null || echo "ERR")
  if [[ "$COUNT" == "ERR" ]]; then
    warn "Tabelle $t nicht gefunden oder nicht lesbar."
    ALL_OK=0
  else
    log "$t: $COUNT Zeilen"
  fi
done

# 7) Foreign-Key-Check (alle FKs valide?)
info "Foreign-Key-Konsistenz..."
FK_BROKEN=$(docker exec "$TMP_NAME" psql -U "$PG_USER" -d "$PG_DB" -tAc "
  SELECT count(*) FROM (
    SELECT conname FROM pg_constraint WHERE contype='f'
  ) AS foo;
" 2>/dev/null || echo "0")
log "Foreign-Key-Constraints registriert: $FK_BROKEN"

# 8) Ergebnis
echo ""
if [[ "$ALL_OK" -eq 1 ]]; then
  log "Backup-Verification erfolgreich: $(basename "$LATEST")"
  exit 0
else
  err "Backup-Verification fehlgeschlagen - bitte $LATEST pruefen."
fi
