#!/bin/bash
# =============================================
# Discord-V-Bot — Backup Script
# Sichert Datenbank, .env und Uploads
# =============================================
set -euo pipefail

GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

BOT_DIR="/opt/discord-v-bot"
BACKUP_DIR="/opt/discord-v-bot-backups"
DB_NAME="discord_v_bot"
TIMESTAMP=$(date '+%Y%m%d_%H%M%S')
BACKUP_PATH="${BACKUP_DIR}/backup_${TIMESTAMP}"
KEEP_DAYS=7

log()  { echo -e "${GREEN}[✓]${NC} $1"; }
info() { echo -e "${BLUE}[i]${NC} $1"; }
err()  { echo -e "${RED}[✗]${NC} $1"; exit 1; }

if [[ $EUID -ne 0 ]]; then
  err "Bitte als root ausführen: sudo bash backup.sh"
fi

mkdir -p "$BACKUP_PATH"

# Datenbank sichern
info "Datenbank wird gesichert..."
sudo -u postgres pg_dump "$DB_NAME" > "${BACKUP_PATH}/database.sql"
log "Datenbank gesichert"

# .env sichern
if [[ -f "$BOT_DIR/.env" ]]; then
  cp "$BOT_DIR/.env" "${BACKUP_PATH}/.env"
  log ".env gesichert"
fi

# Uploads sichern
if [[ -d "$BOT_DIR/uploads" ]] && [[ "$(ls -A "$BOT_DIR/uploads" 2>/dev/null)" ]]; then
  info "Uploads werden gesichert..."
  tar -czf "${BACKUP_PATH}/uploads.tar.gz" -C "$BOT_DIR" uploads/
  log "Uploads gesichert"
fi

# Backup komprimieren
info "Backup wird komprimiert..."
tar -czf "${BACKUP_DIR}/backup_${TIMESTAMP}.tar.gz" -C "$BACKUP_DIR" "backup_${TIMESTAMP}/"
rm -rf "$BACKUP_PATH"
log "Backup erstellt: backup_${TIMESTAMP}.tar.gz"

# Alte Backups löschen
info "Alte Backups werden bereinigt (>${KEEP_DAYS} Tage)..."
find "$BACKUP_DIR" -name "backup_*.tar.gz" -mtime +${KEEP_DAYS} -delete 2>/dev/null || true
log "Bereinigung abgeschlossen"

# Größe anzeigen
SIZE=$(du -sh "${BACKUP_DIR}/backup_${TIMESTAMP}.tar.gz" | cut -f1)
TOTAL=$(du -sh "$BACKUP_DIR" | cut -f1)
echo ""
log "Backup: ${SIZE} | Gesamt: ${TOTAL} | Aufbewahrung: ${KEEP_DAYS} Tage"
