# Step 4: update stages 27-67 in stage-matrix-1-67.json (audit artifacts only)
$ErrorActionPreference = 'Stop'
$root = (Get-Location).Path
$path = Join-Path $root 'docs\audit\stage-matrix-1-67.json'
if (-not (Test-Path $path)) { throw "missing $path" }
$m = Get-Content $path -Raw -Encoding UTF8 | ConvertFrom-Json
$freeze = '48bbcfface38068bc71ad7bcc5c1dd87616da514'
$now = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')

$rows = @(
  @{ s=27; st='PARTIAL'; f=@('F-S4-01','F-S3-08')
     e='docs/dashboard-action-matrix.json basedOnMainSha b9e39ad stale | architecture dashboardActionMatrixArchitecture | devIncidentContract OPERATIONAL_INCIDENT_ACTIONS empty fail-closed | 34 Playwright specs | #73 full-control E2E open'
     n='Action inventory and architecture gates present. Incident actions fail-closed. Not full authenticated mutation E2E of every control at freeze SHA.' }
  @{ s=28; st='PARTIAL'; f=@('F-S4-01')
     e='docs/dashboard-pagination-matrix.json sha 1d61fdf3 stale | dashboardPaginationMatrixArchitecture'
     n='Pagination matrix is doc plus static architecture gate. No freeze-SHA re-inventory. #73 HOCH open.' }
  @{ s=29; st='PARTIAL'; f=@('F-S4-01')
     e='docs/dashboard-error-state-matrix.json sha 7c138b21 stale | dashboardErrorStateMatrixArchitecture'
     n='Error taxonomy inventoried with stale SHA. Not every surface E2E-forced at freeze.' }
  @{ s=30; st='PARTIAL'; f=@('F-S4-01','F-S3-07')
     e='docs/dashboard-desktop-completion-matrix.json sha 9ff08c6d stale | residualRisks | e2e page-matrix | GH Playwright 32525882181 success'
     n='Desktop surfaces documented historically. Stale basedOnMainSha vs 48bbcffa. PARTIAL.' }
  @{ s=31; st='PARTIAL'; f=@('F-S4-02','F-S3-02')
     e='docs/dashboard-mobile-320-matrix.json stale SHA | mobile.spec.ts | Playwright smoke 32525882181'
     n='320px checks claim verified on stale SHA. Smoke E2E is not full control matrix.' }
  @{ s=32; st='PARTIAL'; f=@('F-S4-02','F-S3-02')
     e='docs/dashboard-mobile-360-matrix.json stale SHA | mobile e2e + architecture'
     n='360px matrix PARTIAL same rationale as 320.' }
  @{ s=33; st='PARTIAL'; f=@('F-S4-02','F-S3-02')
     e='docs/dashboard-mobile-375-matrix.json stale SHA | mobile e2e + architecture'
     n='375px matrix PARTIAL same rationale as 320.' }
  @{ s=34; st='PARTIAL'; f=@('F-S4-02','F-S3-02')
     e='docs/dashboard-mobile-390-matrix.json stale SHA | mobile e2e + architecture'
     n='390px matrix PARTIAL same rationale as 320.' }
  @{ s=35; st='PARTIAL'; f=@('F-S4-02','F-S3-02')
     e='docs/dashboard-mobile-430-matrix.json stale SHA | mobile e2e + architecture'
     n='430px matrix PARTIAL same rationale as 320.' }
  @{ s=36; st='PARTIAL'; f=@('F-S4-03')
     e='docs/dashboard-api-authentication-matrix.json 10 cases sha ebee0666 | requireAuthSessionGate | middleware'
     n='Strong session inventory and unit gates. Matrix SHA drift. Not full live auth matrix re-run at freeze.' }
  @{ s=37; st='PARTIAL'; f=@('F-S4-03','F-PRE-01')
     e='idor matrix 10 attackCases 5 roles | auth.ts requireGuildPermission fail-closed | economyScopeGuard | eslint no-unscoped-prisma'
     n='Runtime AuthZ patterns present. Local test:ci red undermines gate confidence. #73 API security open.' }
  @{ s=38; st='PARTIAL'; f=@('F-S4-03')
     e='validation-race-idempotency matrix | idempotency.ts IDEMPOTENCY_STORE_UNAVAILABLE fail-closed'
     n='Idempotency fail-closed is real code. Full concurrent race E2E not re-proven at freeze.' }
  @{ s=39; st='PARTIAL'; f=@('F-S4-04')
     e='git-history-secret-hygiene clean-current-tree | followUp gitleaks deferred | CI npm audit not full-history scanner'
     n='Current tree hygiene documented. Full-history secret scanner not blocking on freeze.' }
  @{ s=40; st='PARTIAL'; f=@('F-S4-03')
     e='roles-permission-attack-matrix 7 cases | architecture string gates | sha 2076eee1 stale'
     n='Doc-verified cases plus code patterns. #73 roles attack open.' }
  @{ s=41; st='PARTIAL'; f=@('F-S4-03')
     e='csrf-xss-matrix 4 cases | csrfXssMatrixArchitecture'
     n='Architecture-level CSRF/XSS inventory only. PARTIAL.' }
  @{ s=42; st='PARTIAL'; f=@('F-S4-03')
     e='ssrf-injection-path-traversal-matrix 3 cases | architecture'
     n='Thin case count. Static architecture evidence only.' }
  @{ s=43; st='PARTIAL'; f=@('F-S4-03')
     e='session-oauth-security-matrix 4 cases | custom OAuth auth.ts | no passport-discord runtime import'
     n='Custom OAuth path present. Matrix SHA stale.' }
  @{ s=44; st='PARTIAL'; f=@('F-S4-03')
     e='upload-webhook-security-matrix 2 cases | tests/security webhook'
     n='Minimal case inventory. PARTIAL.' }
  @{ s=45; st='PARTIAL'; f=@('F-S4-05','F-PRE-03')
     e='CI Security Audit SUCCESS 48bbcffa critical-block high-report-only root | SBOM non-blocking | deepmerge-ts high | Dockerfile no COPY .env'
     n='SBOM/container gates exist but highs open and SBOM gen non-blocking. #73 SBOM final unchecked.' }
  @{ s=46; st='PARTIAL'; f=@('F-S4-06')
     e='scripts/runtime-baseline-i.mjs runs local RSS/heap samples | matrix sha f50a9c11 | observational baselines'
     n='Harness real. No freeze-SHA production SLO thresholds in CI.' }
  @{ s=47; st='PARTIAL'; f=@('F-S4-06')
     e='scripts/runtime-baseline-ii-check.mjs | matrix sha c6472086'
     n='Structural baseline II only.' }
  @{ s=48; st='PARTIAL'; f=@('F-S4-06')
     e='ai-nitrado-performance-baseline-matrix | architecture timeout surfaces | no measured load numbers'
     n='Doc plus static. No measured AI/Nitrado perf on freeze.' }
  @{ s=49; st='PARTIAL'; f=@('F-S4-06')
     e='memory-leak-audit-matrix | architecture | no long-run proof'
     n='No long-run leak proof. PARTIAL.' }
  @{ s=50; st='PARTIAL'; f=@('F-S4-06')
     e='load-test-smoke.mjs skipped without LOAD_TEST_BASE_URL | no CI load job'
     n='Load test not executed against target at freeze.' }
  @{ s=51; st='PARTIAL'; f=@('F-S4-06')
     e='soak-test-smoke.mjs short loops of runtime-baseline-i | not multi-hour soak'
     n='Smoke soak only.' }
  @{ s=52; st='PARTIAL'; f=@('F-S4-06')
     e='ram-node-heap-tuning decision no production heap flag change | prod metrics deferred'
     n='Explicit non-change. Missing prod metrics keep PARTIAL.' }
  @{ s=53; st='PARTIAL'; f=@('F-S4-05','F-PRE-03')
     e='dependency-audit decision no bulk upgrades | lockfile retained | 3 high deepmerge-ts remain'
     n='Controlled-update policy documented. Open highs block security-final.' }
  @{ s=54; st='PARTIAL'; f=@('F-S4-07','F-PRE-05')
     e='passport-discord 0.1.4 still in package.json dependencies | zero src imports | custom OAuth auth.ts'
     n='Dead direct dependency remains. Deprecation debt open per #73.' }
  @{ s=55; st='PARTIAL'; f=@('F-S4-07','F-PRE-05')
     e='inflight-glob-cleanup no-override policy | deprecations still in tree'
     n='Policy freeze without proven cleanup completion.' }
  @{ s=56; st='PARTIAL'; f=@('F-S4-08','F-PRE-04')
     e='bundle-codesplit lazy DEV_PAGES | #73 bundle over 500kB open | vite measure contract only'
     n='Some code-splitting exists. Bundle budget not closed at freeze.' }
  @{ s=57; st='PARTIAL'; f=@('F-S4-09')
     e='dead-code-legacy-cleanup decision no mass deletion | inventory only'
     n='Cleanup deferred. PARTIAL.' }
  @{ s=58; st='PARTIAL'; f=@('F-S4-10')
     e='full-user-journey-e2e-matrix 8 step pointers | architecture only checks length and e2e dir | #73 journey open'
     n='No single Join-to-Rejoin E2E proof at freeze.' }
  @{ s=59; st='PARTIAL'; f=@('F-S4-11')
     e='chaos-smoke.mjs structural faults list | note staging required | idempotency fail-closed code'
     n='Structural chaos inventory only. Not real fault injection.' }
  @{ s=60; st='PARTIAL'; f=@('F-S4-12','F-PRE-01','F-PRE-10')
     e='gesamtaudit-1 matrix sha 45caf9cd | arch count Architecture tests and v2 auth | local test:ci failures'
     n='Meta-gate exists but local CLI architecture failures and stale SHA prevent VERIFIED.' }
  @{ s=61; st='PARTIAL'; f=@('F-S4-12')
     e='gesamtaudit-2-couplings-matrix | structure coupling audit artifacts from prior step | thin architecture'
     n='Coupling audit docs exist. Not re-verified as green full suite.' }
  @{ s=62; st='PARTIAL'; f=@('F-S4-12')
     e='gesamtaudit-3-production-reality env docker deploy presence | deploy scripts present | no live prod proof'
     n='Readiness inventory only.' }
  @{ s=63; st='PARTIAL'; f=@('F-S4-13')
     e='release-sha-freeze-matrix basedOnMainSha 45caf9cd NOT 48bbcffa | architecture policy strings only | #73 release SHA open'
     n='Policy documented. Matrix not pinned to current freeze SHA.' }
  @{ s=64; st='PARTIAL'; f=@('F-S4-14')
     e='PR 235 237 238 Final Gate 1 narrative | CI 32525882200 SUCCESS on 48bbcffa | #73 Gate 1/2 open | local test:ci red'
     n='CI success real but tracker 2/2 protocol and local CLI divergence open.' }
  @{ s=65; st='PARTIAL'; f=@('F-S4-14')
     e='PR 238 claims 64-65 revalidation | only one main push evidence cycle in baseline | #73 Gate 2/2 open'
     n='Second independent gate cycle not tracker-closed.' }
  @{ s=66; st='PARTIAL'; f=@('F-S4-14')
     e='CI 32525882200 Security Lint Tests Docker Publish SUCCESS | Playwright 32525882181 SUCCESS | headSha 48bbcffa | local CLI not green | #73 main Docker Playwright open'
     n='GitHub main gates green on freeze. Fail-closed audit keeps PARTIAL due to #73 and local CLI gaps.' }
  @{ s=67; st='BLOCKED'; f=@('F-S4-15')
     e='deploy/smoke.sh setup.sh update.sh present | no prod credentials in audit session | #73 deploy live smoke open'
     n='Live production deploy/smoke cannot be verified without access. BLOCKED.' }
)

foreach ($r in $rows) {
  $stageObj = $m.stages | Where-Object { $_.stage -eq $r.s } | Select-Object -First 1
  if (-not $stageObj) { throw "missing stage $($r.s)" }
  $stageObj.status = $r.st
  $stageObj.findings = @($r.f)
  $stageObj.evidenceAtFreezeSha = $r.e
  $stageObj.notes = $r.n
  if (-not $stageObj.PSObject.Properties['auditStep']) {
    $stageObj | Add-Member -NotePropertyName auditStep -NotePropertyValue 4
  } else { $stageObj.auditStep = 4 }
  if (-not $stageObj.PSObject.Properties['auditedAt']) {
    $stageObj | Add-Member -NotePropertyName auditedAt -NotePropertyValue $now
  } else { $stageObj.auditedAt = $now }
  # refresh basedOnShaInDocs from docs when listed
}

$counts = [ordered]@{ VERIFIED=0; PARTIAL=0; FAILED=0; BLOCKED=0; PENDING=0 }
foreach ($stageObj in $m.stages) {
  $key = [string]$stageObj.status
  if ($counts.Contains($key)) { $counts[$key]++ } else { $counts[$key] = 1 }
}
$m.statusCounts = [pscustomobject]$counts
$m.step = 4
$m.generatedAt = $now
$m.productionReady = $false
$m.finalScore = $null
$step4meta = [pscustomobject]@{
  completedAt = $now
  freezeSha = $freeze
  report = 'docs/audit/evidence-pass-step4.md'
  findings = 'docs/audit/findings-step4.json'
}
if (-not $m.PSObject.Properties['step4']) {
  $m | Add-Member -NotePropertyName step4 -NotePropertyValue $step4meta
} else { $m.step4 = $step4meta }

$json = $m | ConvertTo-Json -Depth 100
[System.IO.File]::WriteAllText($path, $json, [System.Text.UTF8Encoding]::new($false))
Write-Output "Updated $path"
Write-Output ($counts | ConvertTo-Json -Compress)
