#!/bin/bash
# Ensures that an explicitly enabled /metrics endpoint is never deployed without
# a strong Bearer token. The generated secret is stored only in the local .env
# and is never printed to stdout/stderr.
set -euo pipefail

ENV_FILE="${1:-.env}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "[i] Metrics-Bootstrap: $ENV_FILE nicht vorhanden; nichts zu tun."
  exit 0
fi

metrics_enabled="$(grep -E '^[[:space:]]*METRICS_ENABLED[[:space:]]*=' "$ENV_FILE" | tail -1 | sed -E 's/^[^=]*=[[:space:]]*//; s/[[:space:]]+$//' | tr '[:upper:]' '[:lower:]' || true)"
if [[ "$metrics_enabled" != "true" ]]; then
  exit 0
fi

metrics_token="$(grep -E '^[[:space:]]*METRICS_TOKEN[[:space:]]*=' "$ENV_FILE" | tail -1 | sed -E 's/^[^=]*=[[:space:]]*//; s/[[:space:]]+$//' || true)"
if (( ${#metrics_token} >= 32 )); then
  echo "[✓] Metrics-Bootstrap: vorhandener Bearer-Token ist ausreichend lang."
  exit 0
fi

command -v openssl >/dev/null 2>&1 || {
  echo "[✗] Metrics sind aktiviert, aber METRICS_TOKEN fehlt/ist zu kurz und openssl ist nicht verfuegbar." >&2
  exit 1
}

new_token="$(openssl rand -hex 32)"
if [[ ! "$new_token" =~ ^[0-9a-f]{64}$ ]]; then
  echo "[✗] Metrics-Bootstrap konnte kein gueltiges Zufallssecret erzeugen." >&2
  exit 1
fi

if grep -Eq '^[[:space:]]*METRICS_TOKEN[[:space:]]*=' "$ENV_FILE"; then
  # Hex ist sed-sicher; keine Secret-Ausgabe.
  sed -i -E "s|^[[:space:]]*METRICS_TOKEN[[:space:]]*=.*$|METRICS_TOKEN=${new_token}|" "$ENV_FILE"
else
  printf '\nMETRICS_TOKEN=%s\n' "$new_token" >> "$ENV_FILE"
fi

unset new_token metrics_token
chmod go-rwx "$ENV_FILE" 2>/dev/null || true

echo "[✓] Metrics-Bootstrap: fehlender Bearer-Token sicher erzeugt und lokal in .env gespeichert."
