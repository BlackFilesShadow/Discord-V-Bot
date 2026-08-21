# Local CI parity entrypoint (Windows-friendly).
# Usage: powershell -File scripts/local-ci-parity.ps1
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$env:NODE_ENV = 'test'
$env:RUN_DB_TESTS = '1'
$env:CI = 'true'
if (-not $env:DATABASE_URL) {
  $env:DATABASE_URL = 'postgresql://discordbot:testpass_ci_only@127.0.0.1:5433/discord_v_bot_test?schema=public'
}
if (-not $env:DISCORD_TOKEN) { $env:DISCORD_TOKEN = 'test-discord-token-not-real' }
if (-not $env:DISCORD_CLIENT_ID) { $env:DISCORD_CLIENT_ID = '123456789012345678' }
if (-not $env:DISCORD_CLIENT_SECRET) { $env:DISCORD_CLIENT_SECRET = 'test-discord-client-secret-not-real' }
if (-not $env:BOT_OWNER_ID) { $env:BOT_OWNER_ID = '123456789012345678' }
if (-not $env:ENCRYPTION_KEY) { $env:ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' }
if (-not $env:SESSION_SECRET) { $env:SESSION_SECRET = 'test-session-secret-not-real-0123456789abcdef' }
if (-not $env:DASHBOARD_URL) { $env:DASHBOARD_URL = 'http://127.0.0.1:3000' }
if (-not $env:AI_TOOL_STEP_UP_SECRET) { $env:AI_TOOL_STEP_UP_SECRET = 'test-ai-tool-step-up-secret-0123456789abcdef' }

Write-Host '== docker compose test postgres =='
docker compose -f docker-compose.test.yml up -d --wait
if ($LASTEXITCODE -ne 0) { throw 'Failed to start test postgres' }

Write-Host '== prisma migrate deploy =='
npx prisma migrate deploy
if ($LASTEXITCODE -ne 0) { throw 'prisma migrate deploy failed' }

Write-Host '== npm run test:ci =='
npm run test:ci
if ($LASTEXITCODE -ne 0) { throw 'test:ci failed' }

Write-Host '== npm run db:consistency =='
npm run db:consistency
if ($LASTEXITCODE -ne 0) { throw 'db:consistency failed' }

$bash = node scripts/resolve-bash.js
if ($LASTEXITCODE -ne 0 -or -not $bash) { throw 'bash resolve failed' }
Write-Host "== db:lifecycle via $bash =="
& $bash deploy/db-lifecycle-verify.sh
if ($LASTEXITCODE -ne 0) { throw 'db:lifecycle failed' }

Write-Host 'LOCAL CI PARITY GREEN'
