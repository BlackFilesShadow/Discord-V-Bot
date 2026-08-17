import {
  formatGoldenDayzFailures,
  runGoldenDayzEvaluation,
} from '../../src/modules/ai/dayzEvaluation';
import {
  GOLDEN_DAYZ_BENCHMARK,
  GOLDEN_DAYZ_BENCHMARK_VERSION,
} from '../../src/modules/ai/dayzGoldenBenchmark';

describe('AI-19 Golden DayZ benchmark', () => {
  test('corpus is versioned, non-trivial and has unique stable IDs', () => {
    expect(GOLDEN_DAYZ_BENCHMARK_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.v\d+$/);
    expect(GOLDEN_DAYZ_BENCHMARK.length).toBeGreaterThanOrEqual(40);
    const ids = GOLDEN_DAYZ_BENCHMARK.map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);

    const categories = new Set(GOLDEN_DAYZ_BENCHMARK.map((row) => row.category));
    expect(categories).toEqual(new Set(['BOUNDARY', 'VALIDATION', 'LIVE_PREFLIGHT', 'ANSWER_VALIDATION']));
  });

  test('release benchmark scores 100% in every safety-critical category', () => {
    const report = runGoldenDayzEvaluation();
    const failures = formatGoldenDayzFailures(report);

    expect(report.total).toBe(GOLDEN_DAYZ_BENCHMARK.length);
    expect(report.failed).toBe(0);
    expect(report.score).toBe(1);
    for (const [category, summary] of Object.entries(report.categories)) {
      expect(summary.total).toBeGreaterThan(0);
      expect(summary.failed).toBe(0);
      expect(summary.score).toBe(1);
      if (summary.failed > 0) throw new Error(`${category}\n${failures}`);
    }
  });

  test('evaluation report exposes exact case failures instead of hiding aggregate regressions', () => {
    const report = runGoldenDayzEvaluation([
      {
        id: 'intentional-regression-probe',
        category: 'BOUNDARY',
        question: 'Was ist nominal auf meinem Server?',
        expected: 'GENERAL_DAYZ',
      },
    ]);
    expect(report.failed).toBe(1);
    expect(report.score).toBe(0);
    expect(formatGoldenDayzFailures(report)).toContain('intentional-regression-probe');
  });
});
