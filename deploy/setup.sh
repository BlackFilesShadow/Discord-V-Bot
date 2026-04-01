#!/bin/bash
# =============================================
# Discord-V-Bot — Self-Hosting Setup Script
# Für Ubuntu 22.04+ / Debian 12+
# =============================================
set -euo pipefail

# Farben
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[✗]${NC} $1"; exit 1; }
info() { echo -e "${BLUE}[i]${NC} $1"; }

# Root-Check
if [[ $EUID -ne 0 ]]; then
  err "Bitte als root ausführen: sudo bash setup.sh"
fi

echo ""
echo -e "${BLUE}================================================${NC}"
echo -e "${BLUE}  Discord-V-Bot — Self-Hosting Setup${NC}"
echo -e "${BLUE}================================================${NC}"
echo ""

# ----- Konfiguration -----
BOT_USER="discordbot"
BOT_DIR="/opt/discord-v-bot"
REPO_URL="https://github.com/BlackFilesShadow/Discord-V-Bot.git"
NODE_VERSION="22"
DB_NAME="discord_v_bot"
DB_USER="discordbot"
DB_PASS=$(openssl rand -hex 16)

# ----- System-Updates -----
info "System wird aktualisiert..."
apt-get update -qq
apt-get upgrade -y -qq
log "System aktualisiert"

# ----- Abhängigkeiten installieren -----
info "Abhängigkeiten werden installiert..."
apt-get install -y -qq curl git build-essential ca-certificates gnupg lsb-release ufw fail2ban logrotate
log "Abhängigkeiten installiert"

# ----- Node.js 22 LTS installieren -----
if ! command -v node &>/dev/null || [[ "$(node -v | cut -d. -f1 | tr -d v)" -lt "$NODE_VERSION" ]]; then
  info "Node.js ${NODE_VERSION} LTS wird installiert..."
  curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -
  apt-get install -y -qq nodejs
  log "Node.js $(node -v) installiert"
else
  log "Node.js $(node -v) bereits vorhanden"
fi

# ----- PostgreSQL 16 installieren -----
if ! command -v psql &>/dev/null; then
  info "PostgreSQL 16 wird installiert..."
  curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /usr/share/keyrings/postgresql-keyring.gpg
  echo "deb [signed-by=/usr/share/keyrings/postgresql-keyring.gpg] http://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list
  apt-get update -qq
  apt-get install -y -qq postgresql-16
  log "PostgreSQL 16 installiert"
else
  log "PostgreSQL bereits vorhanden"
fi

# PostgreSQL starten
systemctl enable postgresql
systemctl start postgresql

# ----- Datenbank einrichten -----
info "Datenbank wird eingerichtet..."
sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE USER ${DB_USER} WITH PASSWORD '${DB_PASS}';"
sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};"
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE ${DB_NAME} TO ${DB_USER};"
log "Datenbank '${DB_NAME}' erstellt (User: ${DB_USER})"

# ----- Bot-User erstellen -----
if ! id "$BOT_USER" &>/dev/null; then
  useradd -r -m -s /bin/bash "$BOT_USER"
  log "System-User '${BOT_USER}' erstellt"
else
  log "User '${BOT_USER}' bereits vorhanden"
fi

# ----- Repository klonen -----
if [[ -d "$BOT_DIR" ]]; then
  warn "Verzeichnis ${BOT_DIR} existiert bereits — wird aktualisiert"
  cd "$BOT_DIR"
  sudo -u "$BOT_USER" git pull origin main
else
  info "Repository wird geklont..."
  git clone "$REPO_URL" "$BOT_DIR"
  chown -R "$BOT_USER":"$BOT_USER" "$BOT_DIR"
  log "Repository geklont nach ${BOT_DIR}"
fi

# ----- Abhängigkeiten installieren & Build -----
cd "$BOT_DIR"
info "npm-Pakete werden installiert..."
sudo -u "$BOT_USER" npm ci --omit=dev
log "npm-Pakete installiert"

info "Prisma Client wird generiert..."
sudo -u "$BOT_USER" npx prisma generate
log "Prisma Client generiert"

info "TypeScript wird kompiliert..."
sudo -u "$BOT_USER" npm run build
log "Build erfolgreich"

# ----- Verzeichnisse erstellen -----
sudo -u "$BOT_USER" mkdir -p "$BOT_DIR/uploads" "$BOT_DIR/logs"
log "Upload- und Log-Verzeichnisse erstellt"

# ----- .env erstellen -----
ENV_FILE="$BOT_DIR/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  DATABASE_URL="postgresql://${DB_USER}:${DB_PASS}@localhost:5432/${DB_NAME}?schema=public"
  SESSION_SECRET=$(openssl rand -hex 32)
  ENCRYPTION_KEY=$(openssl rand -hex 16)

  cat > "$ENV_FILE" <<ENVEOF
# =============================================
# Discord-V-Bot Konfiguration
# Generiert am $(date '+%Y-%m-%d %H:%M:%S')
# =============================================

# Discord Bot (MUSS angepasst werden!)
DISCORD_TOKEN=HIER_DISCORD_TOKEN_EINTRAGEN
DISCORD_CLIENT_ID=HIER_CLIENT_ID_EINTRAGEN
DISCORD_CLIENT_SECRET=HIER_CLIENT_SECRET_EINTRAGEN
DISCORD_GUILD_ID=HIER_GUILD_ID_EINTRAGEN
BOT_OWNER_ID=HIER_DEINE_DISCORD_USER_ID

# Datenbank
DATABASE_URL=${DATABASE_URL}

# Web-Dashboard (später)
DASHBOARD_PORT=3000
DASHBOARD_URL=http://localhost:3000
SESSION_SECRET=${SESSION_SECRET}
OAUTH2_REDIRECT_URI=http://localhost:3000/auth/callback

# Sicherheit
ADMIN_PASSWORD_HASH=
TWO_FACTOR_ISSUER=Discord-V-Bot
ENCRYPTION_KEY=${ENCRYPTION_KEY}

# Upload-System
UPLOAD_DIR=./uploads
MAX_FILE_SIZE_BYTES=2147483648
ALLOWED_EXTENSIONS=.xml,.json

# AI (mindestens einen Provider konfigurieren)
AI_PROVIDER=groq
GROQ_API_KEY=
GROQ_MODEL=llama-3.3-70b-versatile
GEMINI_API_KEY=
GEMINI_MODEL=gemini-2.0-flash
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4

# Logging
LOG_LEVEL=info
LOG_DIR=./logs
NODE_ENV=production

# Rate Limiting
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX_REQUESTS=30
ENVEOF

  chown "$BOT_USER":"$BOT_USER" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  log ".env erstellt (bitte Discord-Token eintragen!)"
else
  warn ".env existiert bereits — wird nicht überschrieben"
fi

# ----- Datenbank-Migration -----
info "Datenbank-Schema wird angewendet..."
cd "$BOT_DIR"
sudo -u "$BOT_USER" bash -c "cd $BOT_DIR && npx prisma db push --skip-generate"
log "Datenbank-Schema angewendet"

# ----- systemd Service -----
info "systemd Service wird eingerichtet..."
cat > /etc/systemd/system/discord-v-bot.service <<SERVICEEOF
[Unit]
Description=Discord-V-Bot
Documentation=https://github.com/BlackFilesShadow/Discord-V-Bot
After=network-online.target postgresql.service
Wants=network-online.target
Requires=postgresql.service

[Service]
Type=simple
User=${BOT_USER}
Group=${BOT_USER}
WorkingDirectory=${BOT_DIR}
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=10
StartLimitBurst=5
StartLimitIntervalSec=60

# Sicherheit
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${BOT_DIR}/uploads ${BOT_DIR}/logs
PrivateTmp=true

# Umgebung
Environment=NODE_ENV=production
EnvironmentFile=${BOT_DIR}/.env

# Limits
LimitNOFILE=4096
MemoryMax=512M
CPUQuota=80%

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=discord-v-bot

[Install]
WantedBy=multi-user.target
SERVICEEOF

systemctl daemon-reload
systemctl enable discord-v-bot
log "systemd Service eingerichtet"

# ----- Logrotate -----
cat > /etc/logrotate.d/discord-v-bot <<LOGEOF
${BOT_DIR}/logs/*.log {
    daily
    missingok
    rotate 14
    compress
    delaycompress
    notifempty
    copytruncate
    su ${BOT_USER} ${BOT_USER}
}
LOGEOF
log "Logrotate konfiguriert (14 Tage)"

# ----- Firewall (UFW) -----
info "Firewall wird konfiguriert..."
ufw --force reset >/dev/null 2>&1
ufw default deny incoming
ufw default allow outgoing
ufw allow ssh
# Port 3000 bleibt geschlossen (Dashboard kommt später)
ufw --force enable
log "Firewall aktiv (nur SSH erlaubt)"

# ----- Fail2Ban -----
systemctl enable fail2ban
systemctl start fail2ban
log "Fail2Ban aktiv"

# ----- Unattended Upgrades -----
info "Auto-Updates werden eingerichtet..."
apt-get install -y -qq unattended-upgrades apt-listchanges
echo 'Unattended-Upgrade::Automatic-Reboot "false";' > /etc/apt/apt.conf.d/51auto-upgrades
dpkg-reconfigure -plow unattended-upgrades 2>/dev/null || true
log "Sicherheitsupdates automatisch aktiviert"

# ----- Zusammenfassung -----
echo ""
echo -e "${GREEN}================================================${NC}"
echo -e "${GREEN}  Setup abgeschlossen!${NC}"
echo -e "${GREEN}================================================${NC}"
echo ""
echo -e "  ${BLUE}Bot-Verzeichnis:${NC}  ${BOT_DIR}"
echo -e "  ${BLUE}Bot-User:${NC}         ${BOT_USER}"
echo -e "  ${BLUE}Datenbank:${NC}        ${DB_NAME} (User: ${DB_USER})"
echo -e "  ${BLUE}DB-Passwort:${NC}      ${DB_PASS}"
echo -e "  ${BLUE}.env Datei:${NC}       ${BOT_DIR}/.env"
echo ""
echo -e "${YELLOW}  NÄCHSTE SCHRITTE:${NC}"
echo -e "  1. Discord-Token eintragen:  ${BLUE}sudo nano ${BOT_DIR}/.env${NC}"
echo -e "  2. Bot starten:              ${BLUE}sudo systemctl start discord-v-bot${NC}"
echo -e "  3. Status prüfen:            ${BLUE}sudo systemctl status discord-v-bot${NC}"
echo -e "  4. Logs ansehen:             ${BLUE}sudo journalctl -u discord-v-bot -f${NC}"
echo ""
echo -e "${YELLOW}  WICHTIG: DB-Passwort notieren! → ${DB_PASS}${NC}"
echo ""
