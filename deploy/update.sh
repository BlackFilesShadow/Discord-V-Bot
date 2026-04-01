#!/bin/bash
# =============================================
# Discord-V-Bot — Update Script
# Zieht neuesten Code, baut neu, startet den Bot
# =============================================
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

BOT_DIR="/opt/discord-v-bot"
BOT_USER="discordbot"
SERVICE="discord-v-bot"

log()  { echo -e "${GREEN}[✓]${NC} $1"; }
info() { echo -e "${BLUE}[i]${NC} $1"; }
err()  { echo -e "${RED}[✗]${NC} $1"; exit 1; }

if [[ $EUID -ne 0 ]]; then
  err "Bitte als root ausführen: sudo bash update.sh"
fi

echo -e "${BLUE}[i] Discord-V-Bot wird aktualisiert...${NC}"

cd "$BOT_DIR"

# Aktuellen Commit merken
OLD_COMMIT=$(sudo -u "$BOT_USER" git rev-parse --short HEAD)

# Code aktualisieren
info "Git pull..."
sudo -u "$BOT_USER" git pull origin main
NEW_COMMIT=$(sudo -u "$BOT_USER" git rev-parse --short HEAD)

if [[ "$OLD_COMMIT" == "$NEW_COMMIT" ]]; then
  log "Bereits auf dem neuesten Stand (${OLD_COMMIT})"
  exit 0
fi

info "Update: ${OLD_COMMIT} → ${NEW_COMMIT}"

# Dependencies aktualisieren
info "npm-Pakete werden aktualisiert..."
sudo -u "$BOT_USER" npm ci --omit=dev

# Prisma generieren
info "Prisma Client wird generiert..."
sudo -u "$BOT_USER" npx prisma generate

# Build
info "TypeScript wird kompiliert..."
sudo -u "$BOT_USER" npm run build

# Datenbank-Schema aktualisieren
info "Datenbank-Schema wird aktualisiert..."
sudo -u "$BOT_USER" npx prisma db push --skip-generate

# Bot neu starten
info "Bot wird neu gestartet..."
systemctl restart "$SERVICE"
sleep 3

# Status prüfen
if systemctl is-active --quiet "$SERVICE"; then
  log "Update erfolgreich! Bot läuft (${NEW_COMMIT})"
else
  err "Bot konnte nicht gestartet werden! Logs: journalctl -u ${SERVICE} -n 50"
fi
