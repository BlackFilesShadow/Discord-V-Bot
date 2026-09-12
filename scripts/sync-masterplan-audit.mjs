import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const auditDir = path.join(repoRoot, 'docs', 'audit');
const matrixPath = path.join(auditDir, 'stage-matrix-1-67.json');
const scoreboardPath = path.join(auditDir, 'scoreboard-1-67.csv');
const summaryPath = path.join(auditDir, 'masterplan-audit-summary.json');
const reportPath = path.join(auditDir, 'MASTERPLAN-AUDIT-FINAL-REPORT.md');
const checkOnly = process.argv.includes('--check');

const STATUS_ORDER = ['VERIFIED', 'PARTIAL', 'FAILED', 'BLOCKED'];
const STATUS_SET = new Set(STATUS_ORDER);
const STAGE_EVIDENCE_SOURCES = new Map([
  [46, 'docs/runtime-baseline-i-matrix.json'],
  [47, 'docs/runtime-baseline-ii-matrix.json'],
  [48, 'docs/ai-nitrado-performance-baseline-matrix.json'],
  [49, 'docs/memory-leak-audit-matrix.json'],
  [50, 'docs/load-test-matrix.json'],
  [51, 'docs/soak-test-matrix.json'],
  [52, 'docs/ram-node-heap-tuning-matrix.json'],
  [56, 'docs/dashboard-bundle-codesplit-matrix.json'],
  [57, 'docs/dead-code-legacy-cleanup-matrix.json'],
  [58, 'docs/full-user-journey-e2e-matrix.json'],
  [59, 'docs/chaos-test-matrix.json'],
  [60, 'docs/gesamtaudit-1-code-architecture-matrix.json'],
  [61, 'docs/gesamtaudit-2-couplings-matrix.json'],
  [62, 'docs/gesamtaudit-3-production-reality-matrix.json'],
]);

function readUtf8NoBom(file) {
  const bytes = fs.readFileSync(file);
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new Error(`${path.relative(repoRoot, file)} contains a UTF-8 BOM`);
  }
  return bytes.toString('utf8');
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function markdownCell(value) {
  return String(value ?? '')
    .replaceAll('|', '\\|')
    .replaceAll('\r', ' ')
    .replaceAll('\n', ' ');
}

function validateAndNormalizeMatrix(source) {
  if (!source || typeof source !== 'object' || !Array.isArray(source.stages)) {
    throw new Error('stage-matrix-1-67.json must contain stages[]');
  }
  if (source.stages.length !== 67) {
    throw new Error(`expected exactly 67 stages, got ${source.stages.length}`);
  }
  if (!/^[0-9a-f]{40}$/i.test(String(source.finalAuditedSha ?? ''))) {
    throw new Error('finalAuditedSha must be a full 40-character commit SHA');
  }
  if (!/^[0-9a-f]{40}$/i.test(String(source.auditFreezeSha ?? ''))) {
    throw new Error('auditFreezeSha must be a full 40-character commit SHA');
  }
  if (typeof source.generatedAt !== 'string' || Number.isNaN(Date.parse(source.generatedAt))) {
    throw new Error('generatedAt must be an ISO timestamp');
  }

  const seen = new Set();
  const stages = [...source.stages].sort((a, b) => a.id - b.id);
  for (let index = 0; index < stages.length; index += 1) {
    const stage = stages[index];
    const expectedId = index + 1;
    if (stage.id !== expectedId || seen.has(stage.id)) {
      throw new Error(`stage IDs must be unique and exactly 1..67; expected ${expectedId}, got ${stage.id}`);
    }
    seen.add(stage.id);
    if (!STATUS_SET.has(stage.status)) {
      throw new Error(`stage ${stage.id} has invalid status ${stage.status}`);
    }
    if (typeof stage.name !== 'string' || !stage.name.trim()) {
      throw new Error(`stage ${stage.id} has no name`);
    }
    if (!Array.isArray(stage.findings)) {
      throw new Error(`stage ${stage.id} findings must be an array`);
    }
    if (stage.status === 'VERIFIED' && stage.findings.length > 0) {
      throw new Error(`VERIFIED stage ${stage.id} still has findings`);
    }
    if (stage.status !== 'VERIFIED' && stage.findings.length === 0) {
      throw new Error(`${stage.status} stage ${stage.id} must identify at least one residual/finding`);
    }
  }

  for (const [stageId, relativePath] of STAGE_EVIDENCE_SOURCES) {
    const evidencePath = path.join(repoRoot, relativePath);
    const evidence = JSON.parse(readUtf8NoBom(evidencePath));
    const canonical = stages[stageId - 1];
    if (evidence.stage !== stageId) {
      throw new Error(`${relativePath} declares stage ${evidence.stage}; expected ${stageId}`);
    }
    if (!STATUS_SET.has(evidence.status)) {
      throw new Error(`${relativePath} has invalid or missing status ${evidence.status}`);
    }
    if (!Array.isArray(evidence.residual)) {
      throw new Error(`${relativePath} residual must be an array`);
    }
    if (evidence.status === 'VERIFIED' && evidence.residual.length > 0) {
      throw new Error(`${relativePath} is VERIFIED but still has residuals`);
    }
    if (evidence.status !== 'VERIFIED' && evidence.residual.length === 0) {
      throw new Error(`${relativePath} is ${evidence.status} but has no residual`);
    }
    if (canonical.status !== evidence.status) {
      throw new Error(`stage ${stageId} status drift: canonical=${canonical.status}, ${relativePath}=${evidence.status}`);
    }
    if (!canonical.evidence.includes(relativePath)) {
      throw new Error(`stage ${stageId} canonical evidence does not include ${relativePath}`);
    }
  }

  const counts = Object.fromEntries(STATUS_ORDER.map(status => [status, 0]));
  for (const stage of stages) counts[stage.status] += 1;
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  if (total !== 67) throw new Error(`status invariant failed: ${total} != 67`);

  return {
    matrix: { ...source, stages, counts },
    counts,
  };
}

function buildScoreboard(matrix) {
  const rows = ['stage,status,name'];
  for (const stage of matrix.stages) {
    rows.push([stage.id, stage.status, stage.name].map(csvCell).join(','));
  }
  return `${rows.join('\n')}\n`;
}

function buildSummary(matrix, counts) {
  const score = Math.round((counts.VERIFIED / 67) * 100);
  return {
    generatedAt: matrix.generatedAt,
    finalAuditedSha: matrix.finalAuditedSha,
    auditFreezeSha: matrix.auditFreezeSha,
    stagesTotal: 67,
    counts,
    score,
    productionReady: counts.VERIFIED === 67,
    sourceOfTruth: 'docs/audit/stage-matrix-1-67.json',
    notes: 'Derived deterministically; PARTIAL/BLOCKED stages retain explicit residuals and are never promoted by aggregation.',
  };
}

function buildReport(matrix, counts, summary) {
  const unresolved = matrix.stages.filter(stage => stage.status !== 'VERIFIED');
  const lines = [
    '# MASTERPLAN AUDIT – CURRENT RECONCILED STATE',
    '',
    'This report is generated deterministically from `docs/audit/stage-matrix-1-67.json`.',
    'Do not edit this report, the scoreboard, or the summary manually.',
    '',
    '## Identity',
    '',
    '| Field | Value |',
    '| --- | --- |',
    `| Generated | ${matrix.generatedAt} |`,
    `| Final audited/evidence SHA | \`${matrix.finalAuditedSha}\` |`,
    `| Audit freeze SHA | \`${matrix.auditFreezeSha}\` |`,
    '| Stages total | 67 |',
    '',
    '## Recalculated scoreboard',
    '',
    '| Status | Count |',
    '| --- | ---: |',
    ...STATUS_ORDER.map(status => `| ${status} | ${counts[status]} |`),
    `| **TOTAL** | **${Object.values(counts).reduce((sum, value) => sum + value, 0)}** |`,
    '',
    `**Current score: ${summary.score} / 100**`,
    '',
    `**PRODUCTION READY: ${summary.productionReady ? 'YES' : 'NO'}**`,
    '',
    '## Complete stage matrix',
    '',
    '| Stage | Status | Name | Evidence SHA | Residual / note |',
    '| ---: | --- | --- | --- | --- |',
    ...matrix.stages.map(stage => {
      const residual = stage.findings.length > 0 ? stage.findings.join('; ') : (stage.note ?? '—');
      return `| ${stage.id} | ${stage.status} | ${markdownCell(stage.name)} | ${stage.exactSha ? `\`${stage.exactSha}\`` : '—'} | ${markdownCell(residual)} |`;
    }),
    '',
    '## Remaining residuals (priority order)',
    '',
    ...unresolved.map(stage => `- Stage ${stage.id} (${stage.status}): ${stage.findings.map(markdownCell).join('; ')}`),
    '',
    '## Integrity contract',
    '',
    '- `VERIFIED + PARTIAL + FAILED + BLOCKED = 67`.',
    '- Every non-VERIFIED stage names at least one residual/finding.',
    '- A VERIFIED stage cannot retain findings.',
    '- JSON, CSV, and Markdown outputs are UTF-8 without BOM and use LF line endings.',
    '- `npm run audit:check` fails on drift instead of silently regenerating in CI.',
    '',
  ];
  return lines.join('\n');
}

const source = JSON.parse(readUtf8NoBom(matrixPath));
const { matrix, counts } = validateAndNormalizeMatrix(source);
const summary = buildSummary(matrix, counts);
const expected = new Map([
  [matrixPath, stableJson(matrix)],
  [scoreboardPath, buildScoreboard(matrix)],
  [summaryPath, stableJson(summary)],
  [reportPath, buildReport(matrix, counts, summary)],
]);

if (checkOnly) {
  const drift = [];
  for (const [file, content] of expected) {
    if (!fs.existsSync(file) || readUtf8NoBom(file) !== content) {
      drift.push(path.relative(repoRoot, file));
    }
  }
  if (drift.length > 0) {
    throw new Error(`audit artifact drift: ${drift.join(', ')}; run npm run audit:sync`);
  }
  process.stdout.write(`Audit artifacts consistent: ${JSON.stringify(counts)}\n`);
} else {
  for (const [file, content] of expected) fs.writeFileSync(file, content, 'utf8');
  process.stdout.write(`Audit artifacts synchronized: ${JSON.stringify(counts)}\n`);
}
