# Step 6 aggregator — audit artifacts only
$syncScript = Join-Path $PSScriptRoot '..\..\scripts\sync-masterplan-audit.mjs'
& node $syncScript
exit $LASTEXITCODE

$ErrorActionPreference = 'Stop'
$freeze = '48bbcfface38068bc71ad7bcc5c1dd87616da514'
$now = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
$root = Split-Path $PSScriptRoot -Parent
if (-not (Test-Path (Join-Path $PSScriptRoot 'stage-matrix-1-67.json'))) {
  $PSScriptRoot = Join-Path (Get-Location) 'docs\audit'
}
Set-Location (Split-Path $PSScriptRoot -Parent)

$matrix = Get-Content (Join-Path $PSScriptRoot 'stage-matrix-1-67.json') -Raw | ConvertFrom-Json
$allFindings = @()
foreach ($f in @('findings-seed.json','findings-step2.json','findings-step3.json','findings-step4.json','findings-step5.json')) {
  $c = Get-Content (Join-Path $PSScriptRoot $f) -Raw | ConvertFrom-Json
  foreach ($item in $c.findings) {
    $obj = [ordered]@{}
    foreach ($p in $item.PSObject.Properties) { $obj[$p.Name] = $p.Value }
    $obj['sourceFile'] = $f
    $allFindings += [pscustomobject]$obj
  }
}

$supersededBy = @{
  'F-PRE-01' = 'F-S5-01'
  'F-PRE-02' = 'F-S5-02'
  'F-PRE-03' = 'F-S5-03'
  'F-PRE-04' = 'F-S4-08'
  'F-PRE-05' = 'F-S4-07'
  'F-PRE-06' = 'F-S4-01'
  'F-PRE-07' = 'F-S4-03'
  'F-PRE-08' = 'F-S4-14'
  'F-PRE-09' = 'F-S5-09'
  'F-PRE-10' = 'F-S5-04'
  'F-PRE-12' = 'F-S4-13'
  'F-PRE-13' = 'F-S4-15'
  'F-S2-01'  = 'F-S3-04'
  'F-S3-02'  = 'F-S4-02'
  'F-S3-06'  = 'F-S4-01'
  'F-S3-08'  = 'F-S4-01'
}

$sevOrder = @{ BLOCKER=0; CRITICAL=1; HIGH=2; MEDIUM=3; MED=3; LOW=4; INFO=5 }

$catalogItems = @()
foreach ($f in $allFindings) {
  $status = 'OPEN'
  $canonical = $null
  if ($supersededBy.ContainsKey([string]$f.id)) {
    $status = 'SUPERSEDED'
    $canonical = $supersededBy[[string]$f.id]
  }
  $sev = [string]$f.severity
  if ($sev -eq 'MED') { $sev = 'MEDIUM' }
  $stagesVal = $null
  if ($f.PSObject.Properties['stages']) { $stagesVal = $f.stages }
  $classVal = $null
  if ($f.PSObject.Properties['classification']) { $classVal = $f.classification }
  $impact = $null
  if ($f.PSObject.Properties['impact']) { $impact = $f.impact }
  $fix = $null
  if ($f.PSObject.Properties['fix']) { $fix = $f.fix }
  if (-not $fix -and $f.PSObject.Properties['requiredFix']) { $fix = $f.requiredFix }
  $repro = $null
  if ($f.PSObject.Properties['repro']) { $repro = $f.repro }
  $files = $null
  if ($f.PSObject.Properties['files']) { $files = $f.files }

  $catalogItems += [pscustomobject]@{
    id = $f.id
    severity = $sev
    title = $f.title
    status = $status
    supersededBy = $canonical
    stages = $stagesVal
    classification = $classVal
    impact = $impact
    fix = $fix
    repro = $repro
    files = $files
    sourceFile = $f.sourceFile
  }
}

$active = @($catalogItems | Where-Object { $_.status -eq 'OPEN' })

$fixWave = @(
  [pscustomobject]@{ priority=1; severity='BLOCKER'; ids=@('F-S4-15'); title='Production deploy + live smoke (stage 67)'; action='Credentials/runbook required; keep BLOCKED until live evidence on release SHA'; regression='Deploy checklist + live smoke log bound to SHA' }
  [pscustomobject]@{ priority=2; severity='HIGH'; ids=@('F-S3-04'); title='Stage 20 AI tool layer production wiring'; action='Wire hardened tool layer for prod or fail-closed disable; correct Issue #73 claim'; regression='Tools cannot side-effect without policy; no prod stub path' }
  [pscustomobject]@{ priority=3; severity='HIGH'; ids=@('F-S5-03','F-S4-05'); title='Root high CVEs deepmerge-ts via prisma'; action='Upstream/prisma track or signed exception; avoid blind force-fix breaking pin'; regression='npm audit high policy + SBOM on freeze SHA' }
  [pscustomobject]@{ priority=4; severity='HIGH'; ids=@('F-S5-01','F-S5-04'); title='Local vs CI divergence + CRLF gate brittleness'; action='.gitattributes eol=lf; normalize gate string checks; Windows parity docs'; regression='Architecture gates green Windows+Linux same SHA (no assertion weakening)' }
  [pscustomobject]@{ priority=5; severity='HIGH'; ids=@('F-S5-02','F-S5-05','F-S5-07'); title='Local DB/env parity'; action='Compose Postgres + CI env mirror + jest setupEnv + Git Bash for scripts'; regression='db:consistency + PG suites green or CI-only by explicit contract' }
  [pscustomobject]@{ priority=6; severity='HIGH'; ids=@('F-S4-13'); title='Release SHA freeze matrix pin'; action='Regenerate basedOnMainSha to freeze HEAD after any fix commit'; regression='Matrix SHA == git rev-parse HEAD' }
  [pscustomobject]@{ priority=7; severity='HIGH'; ids=@('F-S4-14','F-PRE-14'); title='Final Gate 2/2 + Issue #73 Abschluss'; action='Two independent green main cycles without SHA drift; checkbox only with evidence'; regression='GH job-level success x2' }
  [pscustomobject]@{ priority=8; severity='HIGH'; ids=@('F-S4-01','F-S4-02','F-S4-03'); title='Authenticated dashboard/API/mobile security matrices'; action='Real authenticated E2E + IDOR fail-closed; not regex-only'; regression='Playwright auth matrix + API security on freeze SHA' }
  [pscustomobject]@{ priority=9; severity='HIGH'; ids=@('F-S4-10','F-S4-11','F-S4-12'); title='Journey / Chaos / Gesamtaudit substance'; action='Join-Leave-Rejoin journey; real fault injection; re-audit on freeze SHA'; regression='E2E journey + chaos with faults + architecture green post-CRLF' }
  [pscustomobject]@{ priority=10; severity='HIGH'; ids=@('F-S4-06'); title='Runtime/perf measurement evidence'; action='Real baseline/load/soak/heap artifacts or remain PARTIAL'; regression='SHA-bound metric files under docs/audit' }
  [pscustomobject]@{ priority=11; severity='MEDIUM'; ids=@('F-S4-07','F-S4-08','F-S2-02','F-S2-03','F-S2-07','F-S3-01','F-S3-03','F-S3-07','F-S4-04'); title='Debt pack dependencies/bundle/allowlist/warn-only/test-admin'; action='Controlled cleanup after HIGH wave'; regression='audit+size budget+targeted tests' }
  [pscustomobject]@{ priority=12; severity='LOW'; ids=@('F-S4-09','F-S2-05','F-S2-06','F-S5-08'); title='Dead code / stubs / lint warnings'; action='Cleanup after HIGH/MEDIUM'; regression='optional lint clean' }
)

$sc = $matrix.statusCounts
$score = 100.0
$deductions = New-Object System.Collections.Generic.List[string]
$d = [math]::Min(40, 8 * [int]$sc.FAILED); $score -= $d; [void]$deductions.Add(('FAILED stages x{0} deduct {1}' -f $sc.FAILED, $d))
$d = [math]::Min(20, 10 * [int]$sc.BLOCKED); $score -= $d; [void]$deductions.Add(('BLOCKED stages x{0} deduct {1}' -f $sc.BLOCKED, $d))
$d = [math]::Min(35, 0.75 * [int]$sc.PARTIAL); $score -= $d; [void]$deductions.Add(('PARTIAL stages x{0} deduct {1}' -f $sc.PARTIAL, $d))
$blockers = @($active | Where-Object { $_.severity -eq 'BLOCKER' }).Count
$highs = @($active | Where-Object { $_.severity -eq 'HIGH' }).Count
$meds = @($active | Where-Object { $_.severity -eq 'MEDIUM' }).Count
$d = [math]::Min(15, 15 * $blockers); if ($d -gt 0) { $score -= $d; [void]$deductions.Add(('open BLOCKER x{0} deduct {1}' -f $blockers, $d)) }
$d = [math]::Min(20, 1.5 * $highs); $score -= $d; [void]$deductions.Add(('open HIGH x{0} deduct {1}' -f $highs, $d))
$d = [math]::Min(8, 0.35 * $meds); $score -= $d; [void]$deductions.Add(('open MEDIUM x{0} deduct {1}' -f $meds, $d))
if ($score -lt 0) { $score = 0 }
$finalScore = [math]::Round($score, 1)

$readyReasons = @(
  'Stage 20 FAILED (AI tool layer not production-wired)',
  'Stage 67 BLOCKED (no prod deploy/live smoke credentials)',
  "Open BLOCKER findings: $blockers",
  "Open HIGH findings (active catalog): $highs",
  'Issue #73 remains OPEN; Abschluss checkboxes unchecked',
  'Local CLI full parity not green (env/CRLF/PG) despite GH success',
  'Root npm audit 3 high (deepmerge-ts)',
  'Release freeze matrix basedOnMainSha stale vs 48bbcffa',
  '2/2 independent gate cycles not closed on Issue #73 protocol'
)

$stageExtra = @{
  20 = @('F-S5-01')
  45 = @('F-S5-03')
  53 = @('F-S5-03')
  60 = @('F-S5-01','F-S5-04','F-S5-02')
  61 = @('F-S5-01','F-S5-04')
  62 = @('F-S5-01')
  63 = @('F-S5-09')
  64 = @('F-S5-09','F-S5-01')
  65 = @('F-S5-09','F-S5-01')
  66 = @('F-S5-09','F-S5-01')
  67 = @('F-S5-09')
}

$updatedStages = @()
foreach ($s in $matrix.stages) {
  $findings = @($s.findings)
  $sn = [int]$s.stage
  if ($stageExtra.ContainsKey($sn)) {
    foreach ($fid in $stageExtra[$sn]) {
      if ($findings -notcontains $fid) { $findings += $fid }
    }
  }
  $updatedStages += [pscustomobject][ordered]@{
    stage = $s.stage
    title = $s.title
    status = $s.status
    issue73 = $s.issue73
    mergedPrs = $s.mergedPrs
    docsMatrix = $s.docsMatrix
    basedOnShaInDocs = $s.basedOnShaInDocs
    codeHints = $s.codeHints
    testsHints = $s.testsHints
    findings = $findings
    notes = $s.notes
    evidenceAtFreezeSha = $s.evidenceAtFreezeSha
    step6 = @{
      freezeSha = $freeze
      aggregatedAt = $now
      openFindings = $findings
    }
  }
}

$sortedFindings = $catalogItems | Sort-Object @{ Expression = { if ($sevOrder.ContainsKey($_.severity)) { $sevOrder[$_.severity] } else { 9 } } }, id

$catalog = [ordered]@{
  artifact = 'masterplan-findings-catalog-final'
  schemaVersion = 1
  step = 6
  freezeSha = $freeze
  generatedAt = $now
  totalRaw = $catalogItems.Count
  totalActive = $active.Count
  totalSuperseded = @($catalogItems | Where-Object { $_.status -eq 'SUPERSEDED' }).Count
  severityCountsActive = @{
    BLOCKER = $blockers
    HIGH = $highs
    MEDIUM = $meds
    LOW = @($active | Where-Object { $_.severity -eq 'LOW' }).Count
    INFO = @($active | Where-Object { $_.severity -eq 'INFO' }).Count
  }
  supersessionMap = $supersededBy
  findings = @($sortedFindings)
  fixWave = $fixWave
}

$finalMatrix = [ordered]@{
  artifact = 'masterplan-audit-stage-matrix-1-67'
  schemaVersion = 2
  step = 6
  generatedAt = $now
  branch = 'main'
  freezeSha = $freeze
  freezeShaShort = '48bbcffa'
  productionReady = $false
  finalScore = $finalScore
  finalScoreModel = 'fail-closed-v1'
  scoreDeductions = @($deductions)
  statusCounts = $matrix.statusCounts
  issue73 = $matrix.issue73
  githubMainPushRuns = $matrix.githubMainPushRuns
  recentMerges = $matrix.recentMerges
  mappingNotes = $matrix.mappingNotes
  step6 = @{
    completedAt = $now
    productionReady = $false
    productionReadyReasons = $readyReasons
    cliSummary = @{
      localShaMatch = $true
      ghCiRun = 32525882200
      ghE2eRun = 32525882181
      ghCiConclusion = 'success'
      ghE2eConclusion = 'success'
      localTestCiParity = 'FAIL (CRLF+env+PG+bash)'
      rootAuditHigh = 3
      rootAuditCritical = 0
      dbConsistencyLocal = 'FAIL env_gated'
    }
  }
  stages = $updatedStages
}

$catalog | ConvertTo-Json -Depth 12 | Set-Content -Encoding utf8 (Join-Path $PSScriptRoot 'findings-catalog-final.json')
$finalMatrix | ConvertTo-Json -Depth 14 | Set-Content -Encoding utf8 (Join-Path $PSScriptRoot 'stage-matrix-1-67.json')
$fixWave | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 (Join-Path $PSScriptRoot 'fix-wave-next.json')

$sb = New-Object System.Collections.Generic.List[string]
[void]$sb.Add('stage,status,title,findings')
foreach ($s in $updatedStages) {
  $t = ($s.title -replace '"','""')
  $ff = ($s.findings -join ';')
  [void]$sb.Add("$($s.stage),$($s.status),""$t"",""$ff""")
}
($sb -join "`n") | Set-Content -Encoding utf8 (Join-Path $PSScriptRoot 'scoreboard-1-67.csv')

# compact summary json for report
$summary = [ordered]@{
  freezeSha = $freeze
  generatedAt = $now
  statusCounts = $matrix.statusCounts
  finalScore = $finalScore
  productionReady = $false
  activeFindings = @{
    BLOCKER = $blockers
    HIGH = $highs
    MEDIUM = $meds
    LOW = @($active | Where-Object { $_.severity -eq 'LOW' }).Count
    INFO = @($active | Where-Object { $_.severity -eq 'INFO' }).Count
    total = $active.Count
  }
  scoreDeductions = @($deductions)
  productionReadyReasons = $readyReasons
}
$summary | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 (Join-Path $PSScriptRoot 'masterplan-audit-summary.json')

Write-Output "OK finalScore=$finalScore active=$($active.Count) blockers=$blockers highs=$highs meds=$meds"
