import fs from 'node:fs';
import path from 'node:path';

const matrix = JSON.parse(fs.readFileSync(path.resolve('docs/ram-node-heap-tuning-matrix.json'), 'utf8')) as {
  stage: number;
  status: string;
  residual: unknown[];
  decision: string;
  measurementEvidence: {
    durationMs: number;
    requests: number;
    failures: number;
    heapGrowthMb: number;
    maxHeapUsedMb: number;
    allSoakGatesPassed: boolean;
  };
  productionRuntimeInspection: {
    dockerfileHasNodeOptions: boolean;
    dockerfileHasMaxOldSpaceSize: boolean;
  };
};

const docker = fs.readFileSync(path.resolve('Dockerfile'), 'utf8');

describe('Stage 52 RAM node heap tuning', () => {
  it('derives the no-change decision from measured Stage 51 evidence', () => {
    expect(matrix.stage).toBe(52);
    expect(matrix.status).toBe('VERIFIED');
    expect(matrix.residual).toEqual([]);
    expect(matrix.decision).toMatch(/No production heap flag change/i);
    expect(matrix.measurementEvidence.durationMs).toBeGreaterThanOrEqual(7_200_000);
    expect(matrix.measurementEvidence.requests).toBeGreaterThanOrEqual(10_000);
    expect(matrix.measurementEvidence.failures).toBe(0);
    expect(matrix.measurementEvidence.heapGrowthMb).toBeLessThanOrEqual(0);
    expect(matrix.measurementEvidence.maxHeapUsedMb).toBeGreaterThan(0);
    expect(matrix.measurementEvidence.allSoakGatesPassed).toBe(true);
  });

  it('keeps the production Docker runtime free of an unmeasured heap override', () => {
    expect(matrix.productionRuntimeInspection.dockerfileHasNodeOptions).toBe(false);
    expect(matrix.productionRuntimeInspection.dockerfileHasMaxOldSpaceSize).toBe(false);
    expect(docker).not.toMatch(/\bNODE_OPTIONS\b/);
    expect(docker).not.toMatch(/--max-old-space-size(?:=|\s)/);
  });
});
