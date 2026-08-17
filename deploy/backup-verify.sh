#!/bin/bash
# =============================================
# Discord-V-Bot - Backup Verifier
# Restauriert das letzte Backup in einen Wegwerf-Postgres-Container
# und prueft Restore, Migrationen und DB-Konsistenz fail-closed.
# =============================================
set -euo pipefail

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m'

BOT_DIR="${BOT_DIR:-/opt/discord-v-bot}"
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
err()  { echo -e "${RED}[X]${NC}  $1"; exit 1; }

cleanup() {
  info "Cleanup..."
  docker rm -f "$TMP_NAME" >/dev/null 2>&1 || true
  rm -rf "$TMP_DIR" || true
  rm -f "/tmp/${TMP_NAME}-import.log" || true
}
trap cleanup EXIT

if [[ ! -d "$BACKUP_DIR" ]]; then
  err "Backup-Verzeichnis nicht gefunden: $BACKUP_DIR"
fi

# 1) Letztes Backup finden und kryptografisch pruefen.
LATEST=$(ls -1t "$BACKUP_DIR"/backup_*.tar.gz 2>/dev/null | head -n1 || true)
if [[ -z "$LATEST" ]]; then
  err "Kein backup_*.tar.gz in $BACKUP_DIR gefunden."
fi
CHECKSUM_FILE="${LATEST}.sha256"
if [[ ! -f "$CHECKSUM_FILE" ]]; then
  err "SHA256-Pruefsumme fehlt: $(basename "$CHECKSUM_FILE")"
fi
info "Pruefe: $(basename "$LATEST")"
if ! (cd "$BACKUP_DIR" && sha256sum -c "$(basename "$CHECKSUM_FILE")"); then
  err "SHA256-Pruefung fehlgeschlagen; Backup wird nicht restauriert."
fi
log "SHA256-Pruefsumme gueltig."

# 2) Entpacken.
mkdir -p "$TMP_DIR"
tar -xzf "$LATEST" -C "$TMP_DIR"
SQL_FILE=$(find "$TMP_DIR" -name database.sql -type f | head -n1)
if [[ -z "$SQL_FILE" ]]; then
  err "database.sql nicht im Backup gefunden."
fi
if [[ ! -s "$SQL_FILE" ]]; then
  err "database.sql ist leer."
fi
SQL_SIZE=$(du -h "$SQL_FILE" | cut -f1)
info "SQL-Dump: $SQL_SIZE"

# 3) Wegwerf-Postgres starten.
info "Starte Wegwerf-Postgres ($PG_IMAGE) auf Port $PG_PORT..."
docker run -d --rm \
  --name "$TMP_NAME" \
  -e POSTGRES_USER="$PG_USER" \
  -e POSTGRES_PASSWORD="$PG_PASS" \
  -e POSTGRES_DB="$PG_DB" \
  -p "${PG_PORT}:5432" \
  "$PG_IMAGE" >/dev/null

# 4) Auf Bereitschaft warten; Timeout ist ein harter Fehler.
info "Warte auf Postgres..."
READY=0
for _ in {1..30}; do
  if docker exec "$TMP_NAME" pg_isready -U "$PG_USER" -d "$PG_DB" >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 1
done
if [[ "$READY" -ne 1 ]]; then
  err "Wegwerf-Postgres wurde nicht innerhalb von 30 Sekunden bereit."
fi
log "Postgres ready."

# 5) Dump strikt importieren. Keine Warn-und-weiter-Semantik.
info "Importiere Dump..."
if ! docker exec -i "$TMP_NAME" psql -v ON_ERROR_STOP=1 -U "$PG_USER" -d "$PG_DB" \
  < "$SQL_FILE" >"/tmp/${TMP_NAME}-import.log" 2>&1; then
  cat "/tmp/${TMP_NAME}-import.log" >&2 || true
  err "Backup-Restore fehlgeschlagen."
fi
log "SQL-Restore ohne Fehler abgeschlossen."

# 6) Kanonische Kern-Tabellen muessen vorhanden und lesbar sein.
info "Pruefe Tabellen..."
TABLES=("User" "Package" "Upload" "AuditLog")
for t in "${TABLES[@]}"; do
  COUNT=$(docker exec "$TMP_NAME" psql -v ON_ERROR_STOP=1 -U "$PG_USER" -d "$PG_DB" -tAc \
    "SELECT count(*) FROM \"$t\"" 2>/dev/null) || err "Tabelle $t fehlt oder ist nicht lesbar."
  [[ "$COUNT" =~ ^[0-9]+$ ]] || err "Ungueltiger Count fuer Tabelle $t: $COUNT"
  log "$t: $COUNT Zeilen"
done

# 7) Prisma-Migrationshistorie und physische FK-Validierung pruefen.
MIGRATION_COUNT=$(docker exec "$TMP_NAME" psql -v ON_ERROR_STOP=1 -U "$PG_USER" -d "$PG_DB" -tAc \
  'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;' 2>/dev/null) \
  || err "Prisma-Migrationshistorie ist nicht lesbar."
if ! [[ "$MIGRATION_COUNT" =~ ^[1-9][0-9]*$ ]]; then
  err "Keine gueltige abgeschlossene Prisma-Migrationshistorie gefunden."
fi
log "Abgeschlossene Prisma-Migrationen: $MIGRATION_COUNT"

UNVALIDATED_FKS=$(docker exec "$TMP_NAME" psql -v ON_ERROR_STOP=1 -U "$PG_USER" -d "$PG_DB" -tAc \
  "SELECT count(*) FROM pg_constraint WHERE contype='f' AND NOT convalidated;" 2>/dev/null) \
  || err "Foreign-Key-Status konnte nicht geprueft werden."
[[ "$UNVALIDATED_FKS" == "0" ]] || err "$UNVALIDATED_FKS Foreign Keys sind nicht validiert."
log "Alle Foreign Keys sind validiert."

# 8) DB-3 Scanner ist die kanonische Orphan-/Cross-Scope-Pruefung.
if [[ ! -f "$BOT_DIR/package.json" ]] || [[ ! -d "$BOT_DIR/node_modules" ]]; then
  err "Bot-Runtime fuer kanonischen DB-Konsistenzscan nicht vorhanden: $BOT_DIR"
fi
info "Starte kanonischen DB-Konsistenzscanner gegen Restore..."
RESTORE_DATABASE_URL="postgresql://${PG_USER}:${PG_PASS}@127.0.0.1:${PG_PORT}/${PG_DB}"
if ! (cd "$BOT_DIR" && DATABASE_URL="$RESTORE_DATABASE_URL" npm run db:consistency); then
  err "DB-Konsistenzscanner meldet Fehler im restaurierten Backup."
fi

log "Backup-Verification erfolgreich: $(basename "$LATEST")"
