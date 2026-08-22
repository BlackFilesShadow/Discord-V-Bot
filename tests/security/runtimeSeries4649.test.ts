import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

interface RuntimeSample {
  rssMb: number;
  heapUsedMb: number;
  cpuUserMs: number;
  cpuSystemMs: number;
  workloadChecksum: number;
  eventLoopDelayMsP50: number;
  eventLoopDelayMsP99: number;
  eventLoopDelayMsMax: number;
  resources: {
    count: number;
    requests: number;
    handlesLegacy: number;
    listeners: number;
  };
}

interface RuntimeSeriesResult {
  exactSha: string;
  stage46: {
    sampleCount: number;
    sampleMs: number;
    gc: {
      explicitGcAvailable: boolean;
      observedEvents: number;
      durationMsP50: number | null;
      durationMsP99: number | null;
      durationMsMax: number | null;
    };
    samples: RuntimeSample[];
  };
  stage49: {
    rssSlopeMbPerSample: number;
    heapSlopeMbPerSample: number;
    activeResourceSlopePerSample: number;
    listenerSlopePerSample: number;
  };
}

describe('Stages 46/49 current-SHA runtime series', () => {
  it('captures bounded memory, CPU, GC, event-loop, resource and listener series', () => {
    const expectedSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const raw = execFileSync(
      process.execPath,
      ['--expose-gc', 'scripts/runtime-series-46-49.mjs'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: 30_000,
        env: {
          ...process.env,
          WRITE_PERF_ARTIFACTS: '0',
          RUNTIME_SERIES_SAMPLES: '5',
          RUNTIME_SERIES_SAMPLE_MS: '75',
          RUNTIME_SERIES_SETTLE_MS: '20',
          RUNTIME_SERIES_ALLOC_MB: '2',
        },
      },
    );
    const result = JSON.parse(raw) as RuntimeSeriesResult;

    expect(result.exactSha).toBe(expectedSha);
    expect(result.stage46.sampleCount).toBe(5);
    expect(result.stage46.sampleMs).toBe(75);
    expect(result.stage46.samples).toHaveLength(5);
    expect(result.stage46.gc.explicitGcAvailable).toBe(true);
    expect(result.stage46.gc.observedEvents).toBeGreaterThan(0);
    expect(result.stage46.gc.durationMsP50).not.toBeNull();
    expect(result.stage46.gc.durationMsP99).not.toBeNull();
    expect(result.stage46.gc.durationMsMax).not.toBeNull();

    for (const sample of result.stage46.samples) {
      expect(sample.rssMb).toBeGreaterThan(0);
      expect(sample.heapUsedMb).toBeGreaterThan(0);
      expect(sample.cpuUserMs + sample.cpuSystemMs).toBeGreaterThan(0);
      expect(sample.workloadChecksum).toBeGreaterThan(0);
      expect(sample.eventLoopDelayMsP50).toBeGreaterThanOrEqual(0);
      expect(sample.eventLoopDelayMsP99).toBeGreaterThanOrEqual(sample.eventLoopDelayMsP50);
      expect(sample.eventLoopDelayMsMax).toBeGreaterThanOrEqual(sample.eventLoopDelayMsP99);
      expect(sample.resources.count).toBeGreaterThanOrEqual(0);
      expect(sample.resources.requests).toBeGreaterThanOrEqual(0);
      expect(sample.resources.handlesLegacy).toBeGreaterThanOrEqual(0);
      expect(sample.resources.listeners).toBeGreaterThanOrEqual(0);
    }

    expect(Math.abs(result.stage49.heapSlopeMbPerSample)).toBeLessThan(1);
    expect(Math.abs(result.stage49.rssSlopeMbPerSample)).toBeLessThan(5);
    expect(Math.abs(result.stage49.activeResourceSlopePerSample)).toBeLessThanOrEqual(0.5);
    expect(result.stage49.listenerSlopePerSample).toBe(0);
  });

  it('keeps the production metrics dependency while exposing the probe command', () => {
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8')) as {
      scripts: Record<string, string>;
      dependencies: Record<string, string>;
    };
    expect(pkg.scripts['perf:series-46-49']).toBe(
      'node --expose-gc scripts/runtime-series-46-49.mjs',
    );
    expect(pkg.dependencies['prom-client']).toBe('^15.1.3');
  });
});
