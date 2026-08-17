import { looksLikeLiveServerKnowledgeQuestion } from './dayzKnowledgeBoundary';
import {
  preflightLiveServerQuestion,
  validateLiveServerAnswer,
} from './dayzHallucinationGuard';
import { validateDayzKnowledgeSet } from './dayzConfigValidation';
import {
  GOLDEN_DAYZ_BENCHMARK,
  GOLDEN_DAYZ_BENCHMARK_VERSION,
  type GoldenDayzCase,
} from './dayzGoldenBenchmark';

export type DayzEvaluationCategory = GoldenDayzCase['category'];

export interface DayzEvaluationCaseResult {
  id: string;
  category: DayzEvaluationCategory;
  passed: boolean;
  failures: string[];
}

export interface DayzEvaluationCategorySummary {
  total: number;
  passed: number;
  failed: number;
  score: number;
}

export interface DayzGoldenEvaluationReport {
  version: typeof GOLDEN_DAYZ_BENCHMARK_VERSION;
  total: number;
  passed: number;
  failed: number;
  score: number;
  categories: Record<DayzEvaluationCategory, DayzEvaluationCategorySummary>;
  results: DayzEvaluationCaseResult[];
}

function normalized(value: string): string {
  return value.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
}

function evaluateCase(testCase: GoldenDayzCase): DayzEvaluationCaseResult {
  const failures: string[] = [];

  switch (testCase.category) {
    case 'BOUNDARY': {
      const actual = looksLikeLiveServerKnowledgeQuestion(testCase.question) ? 'LIVE_SERVER' : 'GENERAL_DAYZ';
      if (actual !== testCase.expected) failures.push(`expected ${testCase.expected}, got ${actual}`);
      break;
    }

    case 'VALIDATION': {
      const results = validateDayzKnowledgeSet(testCase.files);
      const target = Array.from(results.values()).find((row) => row.fileName === testCase.targetFile.toLowerCase());
      if (!target) {
        failures.push(`target ${testCase.targetFile} missing`);
        break;
      }
      if (target.validForKnowledge !== testCase.expectedValidForKnowledge) {
        failures.push(`validForKnowledge expected ${testCase.expectedValidForKnowledge}, got ${target.validForKnowledge}`);
      }
      const codes = new Set(target.issues.map((issue) => issue.code));
      for (const expected of testCase.expectedCodes) {
        if (!codes.has(expected)) failures.push(`missing validation code ${expected}`);
      }
      for (const forbidden of testCase.forbiddenCodes ?? []) {
        if (codes.has(forbidden)) failures.push(`unexpected validation code ${forbidden}`);
      }
      break;
    }

    case 'LIVE_PREFLIGHT': {
      const actual = preflightLiveServerQuestion(testCase.question, testCase.guard);
      if (actual.handled !== testCase.expectedHandled) {
        failures.push(`handled expected ${testCase.expectedHandled}, got ${actual.handled}`);
      }
      const response = normalized(actual.response ?? '');
      for (const required of testCase.mustContain ?? []) {
        if (!response.includes(normalized(required))) failures.push(`response missing: ${required}`);
      }
      for (const forbidden of testCase.mustNotContain ?? []) {
        if (response.includes(normalized(forbidden))) failures.push(`response contains forbidden: ${forbidden}`);
      }
      break;
    }

    case 'ANSWER_VALIDATION': {
      const actual = validateLiveServerAnswer(testCase.question, testCase.answer, testCase.guard);
      if (actual.valid !== testCase.expectedValid) {
        failures.push(`valid expected ${testCase.expectedValid}, got ${actual.valid}`);
      }
      for (const expected of testCase.expectedViolations ?? []) {
        if (!actual.violations.includes(expected)) failures.push(`missing violation ${expected}`);
      }
      break;
    }
  }

  return {
    id: testCase.id,
    category: testCase.category,
    passed: failures.length === 0,
    failures,
  };
}

function emptySummary(): DayzEvaluationCategorySummary {
  return { total: 0, passed: 0, failed: 0, score: 1 };
}

/**
 * AI-19 Golden benchmark runner.
 *
 * This is deliberately provider-independent and deterministic: CI must not turn
 * green or red because an external model changed wording, pricing or uptime.
 * The corpus evaluates the safety-critical contracts that surround model use:
 * general-vs-live routing, deterministic DayZ config validation, verified live
 * preflight answers and post-generation hallucination checks.
 *
 * Provider/model quality can feed candidate answers into the same exported
 * validators separately, while this 100% reproducible suite remains the release
 * regression gate.
 */
export function runGoldenDayzEvaluation(
  cases: readonly GoldenDayzCase[] = GOLDEN_DAYZ_BENCHMARK,
): DayzGoldenEvaluationReport {
  const categories: Record<DayzEvaluationCategory, DayzEvaluationCategorySummary> = {
    BOUNDARY: emptySummary(),
    VALIDATION: emptySummary(),
    LIVE_PREFLIGHT: emptySummary(),
    ANSWER_VALIDATION: emptySummary(),
  };

  const results = cases.map(evaluateCase);
  for (const result of results) {
    const summary = categories[result.category];
    summary.total += 1;
    if (result.passed) summary.passed += 1;
    else summary.failed += 1;
  }
  for (const summary of Object.values(categories)) {
    summary.score = summary.total === 0 ? 1 : summary.passed / summary.total;
  }

  const passed = results.filter((result) => result.passed).length;
  return {
    version: GOLDEN_DAYZ_BENCHMARK_VERSION,
    total: results.length,
    passed,
    failed: results.length - passed,
    score: results.length === 0 ? 1 : passed / results.length,
    categories,
    results,
  };
}

export function formatGoldenDayzFailures(report: DayzGoldenEvaluationReport): string {
  return report.results
    .filter((result) => !result.passed)
    .map((result) => `${result.id} [${result.category}]: ${result.failures.join('; ')}`)
    .join('\n');
}
