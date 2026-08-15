#!/usr/bin/env bash
# Smoke-Test fuer das Live-Dashboard (Hetzner-Deploy + lokal).
#
# Prueft, dass die wichtigsten Endpunkte erreichbar sind und nicht-authentifizierte
# Requests sauber fail-closed abgewiesen werden (KEIN 500/Crash).
#
# Aufruf:
#   ./deploy/smoke.sh                     # default localhost:3000
#   ./deploy/smoke.sh https://bot.example.com
#
# Exit-Code != 0 bei jedem unerwarteten Status-Code.

set -u
BASE="${1:-http://localhost:3000}"
echo "Smoke-Test gegen $BASE"
echo "================================"

declare -i fails=0
declare -i passes=0

assert_status() {
  local method="$1" path="$2" expected="$3" label="$4"
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' -X "$method" "${BASE}${path}" --max-time 10 || echo "000")
  if [[ "$code" == "$expected" ]]; then
    printf "  [OK]   %-6s %-40s -> %s  (%s)\n" "$method" "$path" "$code" "$label"
    passes+=1
  else
    printf "  [FAIL] %-6s %-40s -> %s  (erwartet %s, %s)\n" "$method" "$path" "$code" "$expected" "$label"
    fails+=1
  fi
}

# 1) Liveness + ausgelieferte Dashboard-Oberflaeche
assert_status GET  /                                      200 "Dashboard-SPA"
assert_status GET  /health                                200 "Liveness"

# 2) Auth-Gates: geschuetzte Endpunkte muessen ohne Login fail-closed mit 401 liefern.
assert_status GET  /api/stats                             401 "Legacy-API ohne Login"
assert_status GET  /api/v2/guilds                         401 "v2-Guilds ohne Login"
assert_status GET  /api/v2/dev/status/system              401 "Dev-Status ohne Login"
assert_status GET  /api/v2/dev/status/database            401 "Dev-Status DB ohne Login"
assert_status GET  /api/v2/dev/status/discord             401 "Dev-Status Discord ohne Login"
assert_status GET  /api/v2/dev/status/nitrado             401 "Dev-Status Nitrado ohne Login"
assert_status GET  /api/v2/dev/status/ai-providers        401 "Dev-Status AI-Providers ohne Login"
assert_status GET  /api/v2/bot-admin/command-catalog      401 "BotAdmin-Katalog ohne Login"

# Legacy-/admin-Router ist absichtlich entfernt: kein Auth-Leak, Route existiert nicht mehr.
assert_status GET  /admin/users                           404 "Legacy-Admin-API entfernt"

# 3) Health-Probes (oeffentlich)
assert_status GET  /api/health/discord                    200 "Discord-Health public"

# 4) Auth-first-Robustheit: unbekannte v2-Routen werden vor dem Routing durch
# requireAuth abgefangen. Anonyme Clients erhalten deshalb bewusst 401 statt 404.
assert_status GET  /api/v2/does-not-exist                 401 "Auth-first bei unbekannter v2-Route"

# 5) OAuth-Pfad existiert (302/200)
oauth_code=$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/auth/discord" --max-time 10 || echo "000")
if [[ "$oauth_code" == "302" || "$oauth_code" == "200" ]]; then
  printf "  [OK]   GET    /auth/discord                            -> %s  (OAuth-Start)\n" "$oauth_code"
  passes+=1
else
  printf "  [FAIL] GET    /auth/discord                            -> %s  (erwartet 200/302)\n" "$oauth_code"
  fails+=1
fi

echo "================================"
echo "$passes Pass, $fails Fail"
exit $((fails > 0 ? 1 : 0))
