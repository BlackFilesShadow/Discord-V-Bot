throw 'HISTORICAL_AUDIT_SCRIPT_DISABLED: use npm run audit:sync; canonical source is docs/audit/stage-matrix-1-67.json'
$ErrorActionPreference = 'Stop'
$matrixPath = Join-Path $PSScriptRoot 'stage-matrix-1-67.json'
$m = Get-Content $matrixPath -Raw -Encoding UTF8 | ConvertFrom-Json
$freeze = '48bbcfface38068bc71ad7bcc5c1dd87616da514'
$now = '2026-08-21T23:30:00Z'

function E($status, $findings, $notes, $code, $tests) {
  return @{
    status   = $status
    findings = $findings
    notes    = $notes
    code     = $code
    tests    = $tests
  }
}

$evidence = @{}
$evidence[1] = E 'VERIFIED' @('F-PRE-11') 'AI-1 runtime modelRegistry via config; defaults+legacy migrations; unit tests.' @('src/modules/ai/modelRegistry.ts', 'src/config.ts') @('tests/modules/aiModelRegistry.test.ts')
$evidence[2] = E 'PARTIAL' @('F-PRE-11', 'F-S3-01') 'Ops-1 Dockerfile+deploy scripts present; bare-metal/live smoke not re-run this cycle.' @('Dockerfile', 'docker-compose.yml', 'deploy/') @('tests/deploy')
$evidence[3] = E 'VERIFIED' @('F-PRE-11') 'AI-2 installAiProviderRequestCompatibility at index boot; compatibility tests.' @('src/modules/ai/providerRequestCompatibility.ts', 'src/index.ts') @('tests/modules/aiProviderRequestCompatibility.test.ts')
$evidence[4] = E 'VERIFIED' @('F-PRE-11') 'AI-3 conversationMemory explicit guild scope R/W/clear; cleanup via AI runtime.' @('src/modules/ai/conversationMemory.ts', 'src/modules/ai/aiHandler.ts', 'src/modules/ai/runtime.ts') @('tests/modules/conversationMemoryScope.test.ts')
$evidence[5] = E 'VERIFIED' @('F-PRE-11') 'AI-4 nitradoHelp DayZ technical validate/fallback wired in aiHandler.' @('src/modules/ai/nitradoHelp.ts', 'src/modules/ai/aiHandler.ts') @('tests/ai/nitradoHelp.test.ts')
$evidence[6] = E 'PARTIAL' @('F-PRE-11', 'F-PRE-06', 'F-S3-02') 'Mobile 44px CSS present; inventory mobile shell-only=28; #73 full mobile matrix open.' @('dashboard-ui/src/index.css', 'dashboard-ui/src/theme.css') @('dashboard-ui/e2e/mobile.spec.ts')
$evidence[7] = E 'VERIFIED' @('F-PRE-11') 'AI-5 no legacy scope inference; aiHandler passes guildId on memory callsites.' @('src/modules/ai/conversationMemory.ts', 'src/modules/ai/aiHandler.ts') @('tests/modules/conversationMemoryScope.test.ts')
$evidence[8] = E 'VERIFIED' @('F-PRE-11') 'AI-6 wrapUntrustedContext on context bundle; injection firewall tests.' @('src/modules/ai/untrustedContext.ts', 'src/modules/ai/contextBuilder.ts') @('tests/modules/aiContextInjectionFirewall.test.ts')
$evidence[9] = E 'VERIFIED' @('F-PRE-11') 'AI-7 providerCapabilities task routing in getProviderOrder.' @('src/modules/ai/providerCapabilities.ts', 'src/modules/ai/aiHandler.ts') @('tests/modules/providerCapabilities.test.ts', 'tests/modules/providerTaskRouting.test.ts')
$evidence[10] = E 'VERIFIED' @('F-PRE-11') 'AI-8 circuit/cooldown/fallback via providerFailure+providerStats+aiHandler.' @('src/modules/ai/providerFailure.ts', 'src/modules/ai/aiHandler.ts') @('tests/ai/providerFailure.test.ts', 'tests/modules/aiProviderFallbackMatrix.test.ts')
$evidence[11] = E 'VERIFIED' @('F-PRE-11') 'AI-9 promptBudget clampBlock/clampHistory in answerQuestion assembly.' @('src/modules/ai/promptBudget.ts', 'src/modules/ai/aiHandler.ts') @('tests/ai/promptBudget.test.ts')
$evidence[12] = E 'VERIFIED' @('F-PRE-11', 'F-S2-04') 'AI-10 hybrid RAG scoped retrieval; embeddings backfill best-effort.' @('src/modules/ai/guildKnowledge.ts', 'src/modules/ai/embeddings.ts', 'src/modules/ai/contextBuilder.ts') @('tests/ai/guildKnowledgeScopedRetrieval.test.ts')
$evidence[13] = E 'VERIFIED' @('F-PRE-11') 'AI-11 provenance freshness EXPIRED filter + observability counters.' @('src/modules/ai/knowledgeProvenance.ts', 'src/modules/ai/guildKnowledge.ts') @('tests/ai/knowledgeProvenance.test.ts')
$evidence[14] = E 'VERIFIED' @('F-PRE-11') 'AI-12 dayzKnowledgeManifest version/platform/hash; catalog export.' @('src/modules/ai/dayzKnowledgeManifest.ts', 'src/modules/ai/dayz129Catalog.ts') @('tests/ai/dayzKnowledgeManifest.test.ts')
$evidence[15] = E 'VERIFIED' @('F-PRE-11') 'AI-13 general vs live boundary; catalog null on live intent.' @('src/modules/ai/dayzKnowledgeBoundary.ts', 'src/modules/ai/dayz129Catalog.ts') @('tests/ai/dayzKnowledge.test.ts')
$evidence[16] = E 'VERIFIED' @('F-PRE-11', 'F-S3-03') 'AI-14 snapshotService -> indexNitradoSnapshotKnowledge; index fail warn-only.' @('src/modules/nitrado/mirror/snapshotService.ts', 'src/modules/ai/liveServerKnowledgeIndex.ts') @('tests/ai/liveServerKnowledgeIndex.test.ts')
$evidence[17] = E 'VERIFIED' @('F-PRE-11') 'AI-15 validateDayzKnowledgeSet in live index path before commit.' @('src/modules/ai/dayzConfigValidation.ts', 'src/modules/ai/liveServerKnowledgeIndex.ts') @('tests/ai/dayzConfigValidation.test.ts')
$evidence[18] = E 'VERIFIED' @('F-PRE-11') 'AI-16 guard attach+preflight+answer validate on messageCreate and /ai ask.' @('src/modules/ai/dayzHallucinationGuard.ts', 'src/modules/ai/contextBuilder.ts', 'src/modules/ai/aiHandler.ts') @('tests/ai/dayzHallucinationGuard.test.ts')
$evidence[19] = E 'VERIFIED' @('F-PRE-11') 'AI-17 userRecognition only with resolved gameserver scope; not authz.' @('src/modules/ai/userRecognition.ts', 'src/modules/ai/contextBuilder.ts') @('tests/ai/userRecognition.test.ts')
$evidence[20] = E 'FAILED' @('F-S2-01', 'F-S3-04') 'AI-18 toolLayer library+tests only; no prod register/execute wiring.' @('src/modules/ai/toolLayer.ts', 'src/security/aiToolStepUp.ts') @('tests/ai/toolLayer.test.ts')
$evidence[21] = E 'VERIFIED' @('F-PRE-11', 'F-S3-05') 'AI-19 offline golden evaluation suite (not live LLM E2E).' @('src/modules/ai/dayzGoldenBenchmark.ts', 'src/modules/ai/dayzEvaluation.ts') @('tests/ai/dayzGoldenEvaluation.test.ts')
$evidence[22] = E 'VERIFIED' @('F-PRE-11') 'AI-20 metrics via providerStats+contextBuilder observability helpers.' @('src/modules/ai/aiObservability.ts', 'src/modules/ai/providerStats.ts') @('tests/ai/aiObservability.test.ts')
$evidence[23] = E 'PARTIAL' @('F-PRE-06', 'F-S3-06', 'F-S3-07') 'Etappe 23 inventory 57/16/43; inventoriedMainSha b98e2cf STALE vs freeze; many partial/shell-only.' @('docs/dashboard-surface-inventory.json', 'dashboard-ui/src/App.tsx', 'src/dashboard/routes/v2.ts') @('tests/security/dashboardSurfaceInventoryArchitecture.test.ts')
$evidence[24] = E 'PARTIAL' @('F-PRE-06', 'F-S3-06', 'F-S3-08') 'Button matrix 351; arch AST gate; sha 3daf103 stale; #73 unchecked.' @('docs/dashboard-button-matrix.json') @('tests/security/dashboardButtonMatrixArchitecture.test.ts')
$evidence[25] = E 'PARTIAL' @('F-PRE-06', 'F-S3-08') 'Switch matrix reachable AST + reviewed set; no freeze SHA in md; #73 unchecked.' @('docs/dashboard-switch-matrix.md', 'dashboard-ui/src/components/ui/Switch.tsx') @('tests/security/dashboardSwitchMatrixArchitecture.test.ts')
$evidence[26] = E 'PARTIAL' @('F-PRE-06', 'F-S3-06', 'F-S3-08') 'CRUD matrix basedOnMainSha d71b21e stale+pinned in test; #73 unchecked.' @('docs/dashboard-crud-matrix.json') @('tests/security/dashboardCrudMatrixArchitecture.test.ts')

foreach ($s in $m.stages) {
  $n = [int]$s.stage
  if ($n -ge 1 -and $n -le 26 -and $evidence.ContainsKey($n)) {
    $e = $evidence[$n]
    $s.status = $e.status
    $s.findings = @($e.findings)
    $s.notes = $e.notes
    $s.codeHints = @($e.code)
    $s.testsHints = @($e.tests)
    $s | Add-Member -NotePropertyName evidenceAtFreezeSha -Force -NotePropertyValue ([pscustomobject]@{
        freezeSha      = $freeze
        step           = 3
        evaluatedAt    = $now
        evidenceLevel  = 'runtime+tests+docs-crosscheck'
        statusRationale = $e.notes
      })
  }
}

$counts = [ordered]@{ PENDING = 0; VERIFIED = 0; PARTIAL = 0; FAILED = 0; BLOCKED = 0 }
foreach ($s in $m.stages) {
  $st = [string]$s.status
  if (-not $counts.Contains($st)) { $counts[$st] = 0 }
  $counts[$st] = [int]$counts[$st] + 1
}
$m.statusCounts = [pscustomobject]$counts
$m.step = 3
$m.generatedAt = $now
$m.productionReady = $false

$m | ConvertTo-Json -Depth 14 | Set-Content $matrixPath -Encoding UTF8

Write-Output ("statusCounts VERIFIED={0} PARTIAL={1} FAILED={2} PENDING={3} BLOCKED={4}" -f $counts.VERIFIED, $counts.PARTIAL, $counts.FAILED, $counts.PENDING, $counts.BLOCKED)
1..26 | ForEach-Object {
  $st = ($m.stages | Where-Object { [int]$_.stage -eq $_ } | Select-Object -First 1).status
  Write-Output ("{0}={1}" -f $_, $st)
}
