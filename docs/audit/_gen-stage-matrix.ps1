throw 'HISTORICAL_AUDIT_SCRIPT_DISABLED: use npm run audit:sync; canonical source is docs/audit/stage-matrix-1-67.json'
$ErrorActionPreference = 'Stop'
$freeze = '48bbcfface38068bc71ad7bcc5c1dd87616da514'
$stages = New-Object System.Collections.Generic.List[object]

function New-Stage {
  param($n,$title,$i73,$prs,$docs,$shaDoc,$code,$tests,$notes,$findings)
  return [ordered]@{
    stage = $n
    title = $title
    status = 'PENDING'
    issue73 = $i73
    mergedPrs = @($prs)
    docsMatrix = $docs
    basedOnShaInDocs = $shaDoc
    codeHints = @($code)
    testsHints = @($tests)
    evidenceAtFreezeSha = $null
    findings = @($findings)
    notes = $notes
  }
}

$ai = @(
  @(1,'AI provider registry foundation','AI-1',67),
  @(2,'Ops bare-metal / runtime setup','Ops-1',68),
  @(3,'AI provider request compatibility','AI-2',69),
  @(4,'AI conversation memory scope firewall','AI-3',70),
  @(5,'AI DayZ technical grounding firewall','AI-4',71),
  @(6,'Mobile touch-target hardening','Mobile Touch-Target',72),
  @(7,'AI memory scope explicit callsites','AI-5',74),
  @(8,'AI prompt/context injection firewall','AI-6',75),
  @(9,'AI capability registry + routing','AI-7',76),
  @(10,'AI circuit-breaker / fallback','AI-8',77),
  @(11,'AI context budget manager','AI-9',78),
  @(12,'AI hybrid retrieval / RAG','AI-10',79),
  @(13,'AI knowledge trust and freshness','AI-11',80),
  @(14,'AI DayZ Knowledge 2.0 manifest','AI-12',81),
  @(15,'AI general vs live server knowledge split','AI-13',82),
  @(16,'AI Nitrado snapshot to knowledge index','AI-14',83),
  @(17,'AI deterministic XML/JSON validation','AI-15',84),
  @(18,'AI hallucination guard','AI-16',85),
  @(19,'AI max user recognition chain','AI-17',86),
  @(20,'AI hardened tool layer','AI-18',87),
  @(21,'AI golden DayZ benchmark + eval suite','AI-19',88),
  @(22,'AI observability','AI-20',89)
)
foreach ($row in $ai) {
  $code = if ($row[0] -eq 2) { @('deploy','Dockerfile','docker-compose.yml') } elseif ($row[0] -eq 6) { @('dashboard-ui/src') } elseif ($row[0] -eq 16) { @('src/modules/ai','src/modules/nitrado') } else { @('src/modules/ai') }
  $tests = if ($row[0] -eq 6) { @('dashboard-ui/e2e') } else { @('tests') }
  $stages.Add((New-Stage $row[0] $row[1] @{label=$row[2]; checkbox='[x]'; section='Bereits abgeschlossen'} $row[3] $null $null $code $tests 'Audit-constructed map from Issue #73 label (not historic numeric stage id)' @('F-PRE-11'))) | Out-Null
}

$late = @(
  @{n=23;t='Dashboard surface inventory';lab='Etappe 23';cb='[x]';p=@(194);d='docs/dashboard-surface-inventory.json';s='b98e2cf';c=@('dashboard-ui/src','src/dashboard');te=@('tests/security');f=@('F-PRE-06')},
  @{n=24;t='Dashboard button matrix';lab='Dashboard buttons';cb='[ ]';p=@(195);d='docs/dashboard-button-matrix.json';s='3daf103';c=@('dashboard-ui/src');te=@('tests/security/dashboardButtonMatrixArchitecture.test.ts');f=@('F-PRE-06')},
  @{n=25;t='Dashboard switch matrix';lab='Dashboard switches';cb='[ ]';p=@(196);d='docs/dashboard-switch-matrix.md';s=$null;c=@('dashboard-ui/src');te=@('tests/security');f=@('F-PRE-06')},
  @{n=26;t='Dashboard CRUD matrix';lab='Dashboard CRUD';cb='[ ]';p=@(197);d='docs/dashboard-crud-matrix.json';s=$null;c=@('dashboard-ui/src','src/dashboard/routes/v2');te=@('tests/security');f=@('F-PRE-06')},
  @{n=27;t='Dashboard action matrix';lab='Dashboard actions';cb='[ ]';p=@(198);d='docs/dashboard-action-matrix.json';s='b9e39ad';c=@('dashboard-ui/src');te=@('tests/security');f=@('F-PRE-06')},
  @{n=28;t='Dashboard pagination search filter cursor';lab='Dashboard pagination';cb='[ ]';p=@(199);d='docs/dashboard-pagination-matrix.json';s=$null;c=@('dashboard-ui/src');te=@('tests');f=@('F-PRE-06')},
  @{n=29;t='Dashboard error-state matrix';lab='Dashboard errors';cb='[ ]';p=@(200);d='docs/dashboard-error-state-matrix.json';s=$null;c=@('dashboard-ui/src');te=@('tests');f=@('F-PRE-06')},
  @{n=30;t='Dashboard desktop completion matrix';lab='Dashboard desktop';cb='[ ]';p=@(201);d='docs/dashboard-desktop-completion-matrix.json';s=$null;c=@('dashboard-ui/src');te=@('dashboard-ui/e2e');f=@('F-PRE-06')},
  @{n=31;t='Mobile 320px matrix';lab='Mobile 320';cb='[ ]';p=@(202);d='docs/dashboard-mobile-320-matrix.json';s=$null;c=@('dashboard-ui');te=@('dashboard-ui/e2e');f=@('F-PRE-06')},
  @{n=32;t='Mobile 360px matrix';lab='Mobile 360';cb='[ ]';p=@(203);d='docs/dashboard-mobile-360-matrix.json';s=$null;c=@('dashboard-ui');te=@('dashboard-ui/e2e');f=@('F-PRE-06')},
  @{n=33;t='Mobile 375px matrix';lab='Mobile 375';cb='[ ]';p=@(204);d='docs/dashboard-mobile-375-matrix.json';s=$null;c=@('dashboard-ui');te=@('dashboard-ui/e2e');f=@('F-PRE-06')},
  @{n=34;t='Mobile 390px matrix';lab='Mobile 390';cb='[ ]';p=@(205);d='docs/dashboard-mobile-390-matrix.json';s=$null;c=@('dashboard-ui');te=@('dashboard-ui/e2e');f=@('F-PRE-06')},
  @{n=35;t='Mobile 430px matrix';lab='Mobile 430';cb='[ ]';p=@(206);d='docs/dashboard-mobile-430-matrix.json';s=$null;c=@('dashboard-ui');te=@('dashboard-ui/e2e');f=@('F-PRE-06')},
  @{n=36;t='API authentication matrix';lab='API AuthN';cb='[ ]';p=@(207);d='docs/dashboard-api-authentication-matrix.json';s=$null;c=@('src/dashboard/middleware','src/dashboard/routes/v2');te=@('tests/security');f=@('F-PRE-06')},
  @{n=37;t='API authorization scope IDOR matrix';lab='API AuthZ IDOR';cb='[ ]';p=@(208);d='docs/dashboard-api-authorization-scope-idor-matrix.json';s=$null;c=@('src/dashboard');te=@('tests/security');f=@('F-PRE-06')},
  @{n=38;t='API validation race idempotency matrix';lab='API validation race';cb='[ ]';p=@(209);d='docs/dashboard-api-validation-race-idempotency-matrix.json';s=$null;c=@('src/dashboard');te=@('tests/security');f=@('F-PRE-06')},
  @{n=39;t='Git history secret hygiene';lab='Secret scan';cb='[ ]';p=@(210);d='docs/git-history-secret-hygiene-matrix.json';s=$null;c=@('.github','scripts');te=@('tests/security');f=@('F-PRE-07')},
  @{n=40;t='Roles permission attack matrix';lab='Roles attack';cb='[ ]';p=@(211);d='docs/roles-permission-attack-matrix.json';s=$null;c=@('src/dashboard','src');te=@('tests/security');f=@('F-PRE-07')},
  @{n=41;t='CSRF XSS matrix';lab='CSRF XSS';cb='[ ]';p=@(212);d='docs/csrf-xss-matrix.json';s=$null;c=@('src/dashboard','dashboard-ui');te=@('tests/security');f=@('F-PRE-07')},
  @{n=42;t='SSRF injection path traversal matrix';lab='SSRF injection path';cb='[ ]';p=@(213);d='docs/ssrf-injection-path-traversal-matrix.json';s=$null;c=@('src');te=@('tests/security');f=@('F-PRE-07')},
  @{n=43;t='Session OAuth security matrix';lab='Session OAuth';cb='[ ]';p=@(214);d='docs/session-oauth-security-matrix.json';s=$null;c=@('src/dashboard');te=@('tests/security');f=@('F-PRE-07')},
  @{n=44;t='Upload webhook security matrix';lab='Upload webhook';cb='[ ]';p=@(215);d='docs/upload-webhook-security-matrix.json';s=$null;c=@('src');te=@('tests/security');f=@('F-PRE-07')},
  @{n=45;t='Dependency container SBOM security';lab='SBOM deps';cb='[ ]';p=@(216);d='docs/dependency-container-sbom-security-matrix.json';s=$null;c=@('Dockerfile','.github','package-lock.json');te=@('tests/security');f=@('F-PRE-03','F-PRE-07')},
  @{n=46;t='Runtime baseline I';lab='Runtime baseline I';cb='[ ]';p=@(217);d='docs/runtime-baseline-i-matrix.json';s=$null;c=@('src','scripts');te=@('tests/runtime');f=@('F-PRE-07')},
  @{n=47;t='Runtime baseline II';lab='Runtime baseline II';cb='[ ]';p=@(218);d='docs/runtime-baseline-ii-matrix.json';s=$null;c=@('src','scripts');te=@('tests/runtime');f=@('F-PRE-07')},
  @{n=48;t='AI Nitrado performance baseline';lab='AI Nitrado perf';cb='[ ]';p=@(219);d='docs/ai-nitrado-performance-baseline-matrix.json';s=$null;c=@('src/modules/ai','src/modules/nitrado');te=@('tests/runtime');f=@('F-PRE-07')},
  @{n=49;t='Memory leak audit';lab='Memory leak';cb='[ ]';p=@(220);d='docs/memory-leak-audit-matrix.json';s=$null;c=@('src');te=@('tests/runtime');f=@('F-PRE-07')},
  @{n=50;t='Load test';lab='Load test';cb='[ ]';p=@(221);d='docs/load-test-matrix.json';s=$null;c=@('scripts');te=@('tests/runtime');f=@('F-PRE-07')},
  @{n=51;t='Soak test';lab='Soak test';cb='[ ]';p=@(222);d='docs/soak-test-matrix.json';s=$null;c=@('scripts');te=@('tests/runtime');f=@('F-PRE-07')},
  @{n=52;t='RAM Node heap tuning';lab='Heap tuning';cb='[ ]';p=@(223);d='docs/ram-node-heap-tuning-matrix.json';s='45caf9cd';c=@('deploy','Dockerfile','package.json');te=@();f=@('F-PRE-07')},
  @{n=53;t='Dependency audit controlled updates';lab='Dep audit updates';cb='[ ]';p=@(224);d='docs/dependency-audit-controlled-updates-matrix.json';s=$null;c=@('package-lock.json');te=@();f=@('F-PRE-03','F-PRE-05')},
  @{n=54;t='passport-discord migration';lab='passport-discord';cb='[ ]';p=@(225);d='docs/passport-discord-migration-matrix.json';s=$null;c=@('src/dashboard','package.json');te=@();f=@('F-PRE-05')},
  @{n=55;t='inflight glob cleanup';lab='inflight glob';cb='[ ]';p=@(226);d='docs/inflight-glob-cleanup-matrix.json';s=$null;c=@('package-lock.json');te=@();f=@('F-PRE-05')},
  @{n=56;t='Dashboard bundle code splitting';lab='Bundle split';cb='[ ]';p=@(227);d='docs/dashboard-bundle-codesplit-matrix.json';s=$null;c=@('dashboard-ui');te=@();f=@('F-PRE-04')},
  @{n=57;t='Dead code legacy cleanup';lab='Dead code';cb='[ ]';p=@(228);d='docs/dead-code-legacy-cleanup-matrix.json';s=$null;c=@('src','dashboard-ui');te=@();f=@()},
  @{n=58;t='Full user journey E2E';lab='Full journey';cb='[ ]';p=@(229);d='docs/full-user-journey-e2e-matrix.json';s='45caf9cd';c=@('src','dashboard-ui');te=@('dashboard-ui/e2e','tests');f=@('F-PRE-06','F-PRE-08')},
  @{n=59;t='Chaos test matrix';lab='Chaos';cb='[ ]';p=@(230);d='docs/chaos-test-matrix.json';s=$null;c=@('scripts');te=@('tests');f=@('F-PRE-08')},
  @{n=60;t='Gesamtaudit 1 code architecture';lab='Gesamtaudit 1';cb='[ ]';p=@(231);d='docs/gesamtaudit-1-code-architecture-matrix.json';s='45caf9cd';c=@('src','tests/security');te=@('tests/security');f=@('F-PRE-01','F-PRE-10','F-PRE-08')},
  @{n=61;t='Gesamtaudit 2 couplings';lab='Gesamtaudit 2';cb='[ ]';p=@(232);d='docs/gesamtaudit-2-couplings-matrix.json';s=$null;c=@('src');te=@('tests');f=@('F-PRE-02','F-PRE-08')},
  @{n=62;t='Gesamtaudit 3 production reality';lab='Gesamtaudit 3';cb='[ ]';p=@(233);d='docs/gesamtaudit-3-production-reality-matrix.json';s=$null;c=@('src','deploy');te=@('tests');f=@('F-PRE-08')},
  @{n=63;t='Release SHA freeze';lab='Release SHA';cb='[ ]';p=@(234);d='docs/release-sha-freeze-matrix.json';s='45caf9cd';c=@('docs/release-sha-freeze-matrix.json');te=@();f=@('F-PRE-08','F-PRE-12')},
  @{n=64;t='Final Gate 1/2';lab='Final Gate 1/2';cb='[ ]';p=@(235,237,238);d=$null;s=$null;c=@('.github');te=@();f=@('F-PRE-01','F-PRE-08','F-PRE-14')},
  @{n=65;t='Final Gate 2/2';lab='Final Gate 2/2';cb='[ ]';p=@(238);d=$null;s=$null;c=@('.github');te=@();f=@('F-PRE-08','F-PRE-14')},
  @{n=66;t='main Gate Docker Playwright';lab='main Docker Playwright';cb='[ ]';p=@(238);d=$null;s=$null;c=@('.github','Dockerfile');te=@('dashboard-ui/e2e');f=@('F-PRE-01','F-PRE-08','F-PRE-09')},
  @{n=67;t='Production deploy live smoke final score';lab='Deploy live 100/100';cb='[ ]';p=@();d=$null;s=$null;c=@('deploy');te=@();f=@('F-PRE-08','F-PRE-13')}
)

foreach ($m in $late) {
  $sec = if ($m.n -ge 58) { 'Abschluss' } elseif ($m.n -ge 46) { 'HOCH Performance/Ops' } elseif ($m.n -ge 39) { 'HOCH Security' } elseif ($m.n -ge 36) { 'HOCH Dashboard/API' } else { 'HOCH Dashboard/Mobile' }
  $stages.Add((New-Stage $m.n $m.t @{label=$m.lab; checkbox=$m.cb; section=$sec} $m.p $m.d $m.s $m.c $m.te '' $m.f)) | Out-Null
}

$overlays = @(
  @{ id='DB-1..DB-4'; issue73='[x]'; prs=@(90,91,92,93); auditOverlay='Cross-cutting DB scope/FK/consistency/lifecycle'; findings=@('F-PRE-02') },
  @{ id='Discord-1/User-1/Goodbye-1'; issue73='[x]'; prs=@(94,95,96); auditOverlay='Runtime recognition + goodbye'; findings=@() },
  @{ id='Leave-1A..1I'; issue73='[x]'; prs=@(97,98,99,100,152); auditOverlay='Leave saga/outbox/rejoin overlay on 37/40/58'; findings=@('F-PRE-01') },
  @{ id='Nitrado-WL-Ban-reconcile'; issue73='[x]'; prs=@(126,128,129,131,135,136,138,139,142); auditOverlay='Nitrado coupling overlay'; findings=@('F-PRE-01') },
  @{ id='Economy-1I..1N'; issue73='[x]'; prs=@(143,144,145,146,147,148,149,150,151); auditOverlay='Economy ledger/rewards overlay'; findings=@('F-PRE-01') },
  @{ id='Dashboard-1A..2F-pre-23'; issue73='mixed [x]'; prs=@(153,154,156,157,158,159,160,161,162,163,164,165,166,167,168,169,170,171,172,173,174,176,178,179,180,181,183,184,186,187,189,191,192,193); auditOverlay='Absorbed into stages 23-35 evidence'; findings=@('F-PRE-06') }
)

$doc = [ordered]@{
  schemaVersion = 1
  artifact = 'masterplan-audit-stage-matrix-1-67'
  step = 1
  generatedAt = '2026-08-21T21:10:00Z'
  freezeSha = $freeze
  freezeShaShort = '48bbcffa'
  branch = 'main'
  issue73 = [ordered]@{
    number = 73
    state = 'OPEN'
    title = 'Masterplan 100/100 – Produktionsreife Tracker'
    url = 'https://github.com/BlackFilesShadow/Discord-V-Bot/issues/73'
    commentCount = 118
    bodySnapshot = '.issue73-body.txt'
  }
  githubMainPushRuns = @(
    [ordered]@{ name = 'CI/CD Pipeline'; id = 32525882200; conclusion = 'success'; url = 'https://github.com/BlackFilesShadow/Discord-V-Bot/actions/runs/32525882200' },
    [ordered]@{ name = 'E2E (Playwright)'; id = 32525882181; conclusion = 'success'; url = 'https://github.com/BlackFilesShadow/Discord-V-Bot/actions/runs/32525882181' }
  )
  recentMerges = @(
    [ordered]@{ pr = 238; sha = '48bbcfface38068bc71ad7bcc5c1dd87616da514'; title = 'Stage 64-65/67: Final Gate Revalidation' },
    [ordered]@{ pr = 237; sha = '9dc9155868e892c96f4fdc921d5433bd30781285'; title = 'Stage 64/67: Final Gate 1 CI test fixes' },
    [ordered]@{ pr = 235; title = 'Stage 64/67: Final Gate 1 lint scope fix' },
    [ordered]@{ pr = 234; title = 'Stage 63/67: Release SHA Freeze' }
  )
  statusCounts = [ordered]@{ PENDING = 67; VERIFIED = 0; PARTIAL = 0; FAILED = 0; BLOCKED = 0 }
  productionReady = $false
  finalScore = $null
  fieldContract = @('stage','title','status','issue73','mergedPrs','docsMatrix','basedOnShaInDocs','codeHints','testsHints','evidenceAtFreezeSha','findings','notes')
  mappingNotes = @(
    'Stages 1-22 mapped from Issue #73 AI-1..AI-20 + Ops-1 + Mobile labels (audit-constructed numbering).',
    'DB/Leave/Nitrado/Economy/Dashboard-1* are cross-cutting overlays — see overlays[].',
    'Stages 23-63 numbered from PR titles Stage N/67 and docs matrices.',
    'Stages 64-67 are gate/deploy phases; Issue #73 Abschluss still unchecked.',
    'All status=PENDING after Step 1; checkbox [x] is not VERIFIED.'
  )
  overlays = $overlays
  stages = $stages
}

$out = Join-Path $PSScriptRoot 'stage-matrix-1-67.json'
$json = $doc | ConvertTo-Json -Depth 12
[System.IO.File]::WriteAllText($out, $json, [System.Text.UTF8Encoding]::new($false))
Write-Output "Wrote $out stages=$($stages.Count)"
