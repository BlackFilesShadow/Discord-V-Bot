#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const [inputPath, outputPath, sha] = process.argv.slice(2);
if (!inputPath || !outputPath || !sha) {
  console.error('usage: node scripts/audit-summary-from-tsv.mjs <summary.tsv> <summary.json> <sha>');
  process.exit(2);
}
if (!/^[0-9a-f]{40}$/i.test(sha)) {
  console.error(`invalid audit sha: ${sha}`);
  process.exit(2);
}

const raw = fs.readFileSync(inputPath, 'utf8');
const lines = raw.split(/\r?\n/).filter((line) => line.length > 0);
const expectedHeader = [
  'step',
  'status',
  'classification',
  'exitCode',
  'warningLines',
  'durationSec',
  'log',
];

if (lines.length === 0) {
  throw new Error('summary.tsv is empty');
}
const header = lines[0].split('\t');
if (header.length !== expectedHeader.length || header.some((value, index) => value !== expectedHeader[index])) {
  throw new Error(`unexpected summary header: ${lines[0]}`);
}
if (lines.length === 1) {
  throw new Error('summary.tsv contains no audit steps');
}

const allowedStatus = new Set(['PASS', 'FAIL', 'SKIPPED']);
const allowedClassification = new Set([
  'OK',
  'ECHTER FEHLER',
  'WARNUNG',
  'FOLGEFEHLER',
  'TEST-/UMGEBUNGSFEHLER',
]);
const seenSteps = new Set();

const steps = lines.slice(1).map((line, rowIndex) => {
  const parts = line.split('\t');
  if (parts.length !== expectedHeader.length) {
    throw new Error(`malformed summary row ${rowIndex + 2}: expected 7 columns, got ${parts.length}`);
  }
  const [step, status, classification, exitCodeRaw, warningLinesRaw, durationSecRaw, logRaw] = parts;
  if (!step) throw new Error(`empty step name at row ${rowIndex + 2}`);
  if (seenSteps.has(step)) throw new Error(`duplicate audit step: ${step}`);
  seenSteps.add(step);
  if (!allowedStatus.has(status)) throw new Error(`invalid status ${status} for ${step}`);
  if (!allowedClassification.has(classification)) {
    throw new Error(`invalid classification ${classification} for ${step}`);
  }

  const exitCode = exitCodeRaw === '-' ? null : Number(exitCodeRaw);
  const warningLines = Number(warningLinesRaw);
  const durationSec = Number(durationSecRaw);
  const log = logRaw === '-' ? null : logRaw;
  if (exitCode !== null && !Number.isInteger(exitCode)) throw new Error(`invalid exitCode for ${step}`);
  if (!Number.isInteger(warningLines) || warningLines < 0) throw new Error(`invalid warningLines for ${step}`);
  if (!Number.isInteger(durationSec) || durationSec < 0) throw new Error(`invalid durationSec for ${step}`);

  if (status === 'PASS') {
    if (classification !== 'OK' && classification !== 'WARNUNG') {
      throw new Error(`PASS step ${step} has incompatible classification ${classification}`);
    }
    if (exitCode !== 0) throw new Error(`PASS step ${step} must have exitCode 0`);
    if (!log) throw new Error(`PASS step ${step} must reference a log`);
  } else if (status === 'FAIL') {
    if (classification !== 'ECHTER FEHLER' && classification !== 'TEST-/UMGEBUNGSFEHLER') {
      throw new Error(`FAIL step ${step} has incompatible classification ${classification}`);
    }
    if (exitCode === null || exitCode === 0) throw new Error(`FAIL step ${step} must have a non-zero exitCode`);
    if (!log) throw new Error(`FAIL step ${step} must reference a log`);
  } else {
    if (classification !== 'FOLGEFEHLER') {
      throw new Error(`SKIPPED step ${step} must be classified as FOLGEFEHLER`);
    }
    if (exitCode !== null) throw new Error(`SKIPPED step ${step} must not have an exitCode`);
    if (log !== null) throw new Error(`SKIPPED step ${step} must not claim an executed log`);
  }

  return {
    step,
    status,
    classification,
    exitCode,
    warningLines,
    durationSec,
    log,
  };
});

const countStatus = (status) => steps.filter((step) => step.status === status).length;
const warningCandidates = steps.reduce((sum, step) => sum + step.warningLines, 0);
const classificationCounts = Object.fromEntries(
  [...allowedClassification].map((classification) => [
    classification,
    steps.filter((step) => step.classification === classification).length,
  ]),
);
const failed = countStatus('FAIL');
const skipped = countStatus('SKIPPED');

const document = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  sha: sha.toLowerCase(),
  source: path.basename(inputPath),
  totals: {
    steps: steps.length,
    passed: countStatus('PASS'),
    failed,
    skippedFollowups: skipped,
    warningCandidates,
  },
  classificationCounts,
  allGreen: failed === 0 && skipped === 0,
  steps,
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
console.log(
  `summary.json: steps=${document.totals.steps} pass=${document.totals.passed} fail=${document.totals.failed} skipped=${document.totals.skippedFollowups} warningCandidates=${warningCandidates}`,
);
