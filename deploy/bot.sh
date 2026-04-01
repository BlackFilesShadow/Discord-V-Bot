#!/bin/bash
# =============================================
# Discord-V-Bot — Bot-Management
# Einfache Befehle zum Verwalten des Bots
# =============================================

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

SERVICE="discord-v-bot"
BOT_DIR="/opt/discord-v-bot"

case "${1:-help}" in
  start)
    sudo systemctl start "$SERVICE"
    echo -e "${GREEN}[✓] Bot gestartet${NC}"
    ;;
  stop)
    sudo systemctl stop "$SERVICE"
    echo -e "${YELLOW}[!] Bot gestoppt${NC}"
    ;;
  restart)
    sudo systemctl restart "$SERVICE"
    echo -e "${GREEN}[✓] Bot neu gestartet${NC}"
    ;;
  status)
    systemctl status "$SERVICE" --no-pager
    ;;
  logs)
    journalctl -u "$SERVICE" -f --no-pager
    ;;
  logs-last)
    journalctl -u "$SERVICE" -n "${2:-50}" --no-pager
    ;;
  update)
    sudo bash "$BOT_DIR/deploy/update.sh"
    ;;
  backup)
    sudo bash "$BOT_DIR/deploy/backup.sh"
    ;;
  env)
    sudo nano "$BOT_DIR/.env"
    ;;
  db-studio)
    cd "$BOT_DIR" && npx prisma studio
    ;;
  help|*)
    echo ""
    echo -e "${BLUE}Discord-V-Bot Management${NC}"
    echo ""
    echo "  bash bot.sh start       Bot starten"
    echo "  bash bot.sh stop        Bot stoppen"
    echo "  bash bot.sh restart     Bot neu starten"
    echo "  bash bot.sh status      Status anzeigen"
    echo "  bash bot.sh logs        Live-Logs anzeigen"
    echo "  bash bot.sh logs-last   Letzte 50 Log-Zeilen"
    echo "  bash bot.sh update      Code aktualisieren & neu starten"
    echo "  bash bot.sh backup      Backup erstellen"
    echo "  bash bot.sh env         .env bearbeiten"
    echo "  bash bot.sh db-studio   Prisma Studio öffnen"
    echo ""
    ;;
esac
