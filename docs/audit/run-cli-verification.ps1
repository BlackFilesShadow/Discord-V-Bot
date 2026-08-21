# Step 5 reusable CLI verification runner (audit-only).
# Captures command exit codes, summaries, and failed Jest test names.
# Usage (from repo root):
#   powershell -ExecutionPolicy Bypass -File docs\audit\run-cli-verification.ps1
#   powershell -ExecutionPolicy Bypass -File docs\audit\run-cli-verification.ps1 -SkipInstall -OnlyTests
#   powershell -ExecutionPolicy Bypass -File docs\audit\run-cli-verification.ps1 -TestPattern "economy"

param(
  [switch]$SkipInstall,
  [switch]$SkipLint,
  [switch]$SkipBuild,
  [switch]$SkipAudit,
  [switch]$SkipDb,
  [switch]$SkipDashboard,
  [switch]$OnlyTests,
  [string]$TestPattern = "",
  [int]$JestWorkers = 4,
  [int]$TestTimeoutMs = 60000
)

$ErrorActionPreference = "Continue"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Set-Location $Root

$OutDir = Join-Path $Root "docs\audit\cli-evidence"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$SummaryPath = Join-Path $OutDir "summary-$Stamp.json"
$LatestSummary = Join-Path $OutDir "summary-latest.json"
$FailedTestsPath = Join-Path $OutDir "failed-tests-latest.json"
$LogDir = Join-Path $OutDir "logs-$Stamp"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Get-GitSha {
  try { return (git rev-parse HEAD 2>$null).Trim() } catch { return "unknown" }
}

function Invoke-Step {
  param(
    [string]$Name,
    [string]$Command,
    [int]$TimeoutSec = 300,
    [string]$WorkingDirectory = $Root
  )
  $logFile = Join-Path $LogDir ("{0}.log" -f ($Name -replace "[^a-zA-Z0-9_-]", "_"))
  $started = Get-Date
  Write-Host "=== STEP: $Name ===" -ForegroundColor Cyan
  Write-Host "CMD: $Command"
  $prev = Get-Location
  try {
    Set-Location $WorkingDirectory
    $output = & powershell.exe -NoProfile -ExecutionPolicy Bypass -Command $Command 2>&1
    $code = $LASTEXITCODE
    if ($null -eq $code) { $code = 0 }
    $text = ($output | Out-String)
    Set-Content -Path $logFile -Value $text -Encoding UTF8
    $duration = [math]::Round(((Get-Date) - $started).TotalSeconds, 2)
    $tail = if ($text.Length -gt 4000) { $text.Substring($text.Length - 4000) } else { $text }
    return [pscustomobject]@{
      name = $Name
      command = $Command
      exitCode = $code
      ok = ($code -eq 0)
      durationSec = $duration
      log = $logFile
      tail = $tail
    }
  } catch {
    $duration = [math]::Round(((Get-Date) - $started).TotalSeconds, 2)
    $msg = $_.Exception.Message
    Set-Content -Path $logFile -Value $msg -Encoding UTF8
    return [pscustomobject]@{
      name = $Name
      command = $Command
      exitCode = 1
      ok = $false
      durationSec = $duration
      log = $logFile
      tail = $msg
    }
  } finally {
    Set-Location $prev
  }
}

function Parse-JestFailures {
  param([string]$LogText)
  $failed = @()
  $lines = $LogText -split "`r?`n"
  $currentFile = $null
  foreach ($line in $lines) {
    if ($line -match "^\s*FAIL\s+(.+\.test\.ts)") {
      $currentFile = $Matches[1].Trim()
    }
    elseif ($line -match "^\s*[×xX●•]\s+(.+)$" -or $line -match "^\s*\d+\)\s+(.+)$") {
      $testName = $Matches[1].Trim()
      if ($testName -and $currentFile) {
        $failed += [pscustomobject]@{ suite = $currentFile; test = $testName }
      }
    }
    elseif ($line -match "Test Suites:\s*(\d+)\s*failed.*?(\d+)\s*passed.*?(\d+)\s*total") {
      # captured later via summary regex
    }
  }
  # Also capture suite-level FAIL lines uniquely
  $suiteFails = [regex]::Matches($LogText, "(?m)^\s*FAIL\s+(.+\.test\.ts[^\r\n]*)") | ForEach-Object { $_.Groups[1].Value.Trim() } | Select-Object -Unique
  $summary = @{
    failedSuites = @($suiteFails)
    failedTests = $failed
  }
  if ($LogText -match "Test Suites:\s*([^\r\n]+)") {
    $summary.suitesLine = $Matches[1].Trim()
  }
  if ($LogText -match "Tests:\s*([^\r\n]+)") {
    $summary.testsLine = $Matches[1].Trim()
  }
  if ($LogText -match "Time:\s*([^\r\n]+)") {
    $summary.timeLine = $Matches[1].Trim()
  }
  return $summary
}

$sha = Get-GitSha
$envInfo = @{
  node = (node -v)
  npm = (npm -v)
  hasEnvFile = (Test-Path (Join-Path $Root ".env"))
  hasEnvTest = (Test-Path (Join-Path $Root ".env.test"))
  DATABASE_URL_set = [bool]$env:DATABASE_URL
  DISCORD_TOKEN_set = [bool]$env:DISCORD_TOKEN
  os = [System.Environment]::OSVersion.VersionString
  cwd = $Root
  sha = $sha
}

$steps = @()
$jestParsed = $null

if (-not $OnlyTests) {
  if (-not $SkipInstall) {
    $steps += Invoke-Step -Name "root-npm-ci" -Command "npm ci" -TimeoutSec 600
    $steps += Invoke-Step -Name "prisma-generate" -Command "npx prisma generate" -TimeoutSec 120
    $steps += Invoke-Step -Name "prisma-validate" -Command "npx prisma validate" -TimeoutSec 60
  }
  if (-not $SkipLint) {
    $steps += Invoke-Step -Name "lint-all" -Command "npm run lint:all" -TimeoutSec 300
  }
  if (-not $SkipBuild) {
    $steps += Invoke-Step -Name "build" -Command "npm run build" -TimeoutSec 600
  }
  if (-not $SkipAudit) {
    $steps += Invoke-Step -Name "root-audit-critical" -Command "npm audit --audit-level=critical --json > docs/audit/cli-evidence/root-audit-critical.json; npm audit --audit-level=critical" -TimeoutSec 120
    $steps += Invoke-Step -Name "root-audit-high" -Command "npm audit --audit-level=high --json > docs/audit/cli-evidence/root-audit-high.json; npm audit --audit-level=high" -TimeoutSec 120
    $steps += Invoke-Step -Name "root-audit-omit-dev-high" -Command "npm audit --omit=dev --audit-level=high" -TimeoutSec 120
  }
  if (-not $SkipDb) {
    $steps += Invoke-Step -Name "db-consistency" -Command "npm run db:consistency" -TimeoutSec 120
    # db:lifecycle is bash; on Windows may need Git Bash
    $bash = $null
    foreach ($c in @("bash", "C:\Program Files\Git\bin\bash.exe")) {
      if (Get-Command $c -ErrorAction SilentlyContinue) { $bash = $c; break }
      if (Test-Path $c) { $bash = $c; break }
    }
    if ($bash) {
      $steps += Invoke-Step -Name "db-lifecycle" -Command "& '$bash' deploy/db-lifecycle-verify.sh" -TimeoutSec 300
    } else {
      $steps += [pscustomobject]@{
        name = "db-lifecycle"
        command = "bash deploy/db-lifecycle-verify.sh"
        exitCode = 127
        ok = $false
        durationSec = 0
        log = $null
        tail = "bash not found; skipped/blocked on this host"
      }
    }
  }
}

# Tests always run unless user only wants other pieces - default include tests
$jestCmd = "npx jest --coverage --maxWorkers=$JestWorkers --testTimeout=$TestTimeoutMs --ci --json --outputFile=docs/audit/cli-evidence/jest-results-latest.json"
if ($TestPattern) {
  $jestCmd = "npx jest --coverage=false --maxWorkers=$JestWorkers --testTimeout=$TestTimeoutMs --ci -t `"$TestPattern`" --json --outputFile=docs/audit/cli-evidence/jest-results-latest.json"
}
$testStep = Invoke-Step -Name "test-ci" -Command $jestCmd -TimeoutSec 900
$steps += $testStep
if (Test-Path $testStep.log) {
  $jestLogText = Get-Content -Raw -Path $testStep.log -ErrorAction SilentlyContinue
  $jestParsed = Parse-JestFailures -LogText $jestLogText
  # Enrich from JSON if present
  $jestJsonPath = Join-Path $Root "docs\audit\cli-evidence\jest-results-latest.json"
  if (Test-Path $jestJsonPath) {
    try {
      $jr = Get-Content -Raw $jestJsonPath | ConvertFrom-Json
      $failedFromJson = @()
      foreach ($suite in $jr.testResults) {
        if ($suite.status -eq "failed" -or $suite.numFailingTests -gt 0) {
          $rel = $suite.name
          foreach ($a in $suite.assertionResults) {
            if ($a.status -eq "failed") {
              $msg = ($a.failureMessages -join " | ")
              if ($msg.Length -gt 800) { $msg = $msg.Substring(0, 800) }
              $failedFromJson += [pscustomobject]@{
                suite = $rel
                test = $a.fullName
                message = $msg
              }
            }
          }
          if (-not ($suite.assertionResults | Where-Object { $_.status -eq "failed" })) {
            $failedFromJson += [pscustomobject]@{
              suite = $rel
              test = "(suite-level failure)"
              message = (($suite.message | Out-String).Substring(0, [Math]::Min(800, (($suite.message | Out-String).Length))))
            }
          }
        }
      }
      $jestParsed = @{
        success = $jr.success
        numFailedTestSuites = $jr.numFailedTestSuites
        numPassedTestSuites = $jr.numPassedTestSuites
        numTotalTestSuites = $jr.numTotalTestSuites
        numFailedTests = $jr.numFailedTests
        numPassedTests = $jr.numPassedTests
        numTotalTests = $jr.numTotalTests
        startTime = $jr.startTime
        failedSuites = @($jr.testResults | Where-Object { $_.status -eq "failed" -or $_.numFailingTests -gt 0 } | ForEach-Object { $_.name })
        failedTests = $failedFromJson
        suitesLine = $jestParsed.suitesLine
        testsLine = $jestParsed.testsLine
        timeLine = $jestParsed.timeLine
      }
    } catch {
      Write-Host "Jest JSON parse failed: $($_.Exception.Message)" -ForegroundColor Yellow
    }
  }
  $jestParsed | ConvertTo-Json -Depth 8 | Set-Content -Path $FailedTestsPath -Encoding UTF8
}

if (-not $OnlyTests -and -not $SkipDashboard) {
  $ui = Join-Path $Root "dashboard-ui"
  if (-not $SkipInstall) {
    $steps += Invoke-Step -Name "dashboard-npm-ci" -Command "npm ci" -TimeoutSec 600 -WorkingDirectory $ui
  }
  $steps += Invoke-Step -Name "dashboard-build" -Command "npm run build" -TimeoutSec 300 -WorkingDirectory $ui
  if (-not $SkipAudit) {
    $steps += Invoke-Step -Name "dashboard-audit-prod-high" -Command "npm audit --omit=dev --audit-level=high" -TimeoutSec 120 -WorkingDirectory $ui
    $steps += Invoke-Step -Name "dashboard-audit-critical" -Command "npm audit --audit-level=critical" -TimeoutSec 120 -WorkingDirectory $ui
  }
}

$summary = [ordered]@{
  generatedAt = (Get-Date).ToString("o")
  freezeShaExpected = "48bbcfface38068bc71ad7bcc5c1dd87616da514"
  headSha = $sha
  shaMatch = ($sha -eq "48bbcfface38068bc71ad7bcc5c1dd87616da514")
  env = $envInfo
  steps = $steps | ForEach-Object {
    [ordered]@{
      name = $_.name
      command = $_.command
      exitCode = $_.exitCode
      ok = $_.ok
      durationSec = $_.durationSec
      log = $_.log
    }
  }
  jest = $jestParsed
  allGreen = -not ($steps | Where-Object { -not $_.ok })
}

$summary | ConvertTo-Json -Depth 10 | Set-Content -Path $SummaryPath -Encoding UTF8
$summary | ConvertTo-Json -Depth 10 | Set-Content -Path $LatestSummary -Encoding UTF8

Write-Host "`n=== SUMMARY ===" -ForegroundColor Green
Write-Host "SHA: $sha match=$($summary.shaMatch)"
foreach ($s in $steps) {
  $flag = if ($s.ok) { "OK" } else { "FAIL" }
  Write-Host ("[{0}] {1} exit={2} {3}s" -f $flag, $s.name, $s.exitCode, $s.durationSec)
}
if ($jestParsed) {
  Write-Host "Jest failedSuites=$($jestParsed.numFailedTestSuites) failedTests=$($jestParsed.numFailedTests)"
  Write-Host "Failed tests detail: $FailedTestsPath"
}
Write-Host "Summary: $SummaryPath"
Write-Host "Latest: $LatestSummary"

if ($summary.allGreen) { exit 0 } else { exit 1 }
