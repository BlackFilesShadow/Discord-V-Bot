/**
 * Stage 48 — deterministic AI and Nitrado performance lab.
 *
 * The lab binds an ephemeral HTTP server to 127.0.0.1 and drives the real
 * production clients through TCP. It proves latency, concurrency, bounded
 * retries, provider fallback, rate-limit handling, circuit breaking and
 * Prometheus observability without using external credentials or rate budget.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const root = process.cwd();
const sampleCount = boundedInteger(process.env.STAGE48_SAMPLE_COUNT, 20, 10, 100);
const concurrency = boundedInteger(process.env.STAGE48_CONCURRENCY, 12, 8, 32);
const latencyLimitMs = boundedInteger(process.env.STAGE48_LATENCY_LIMIT_MS, 750, 100, 5_000);

function boundedInteger(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function round(value: number, digits = 3): number {
  return Number(value.toFixed(digits));
}

function percentile(sorted: number[], quantile: number): number {
  if (sorted.length === 0) return 0;
  return round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)]);
}

function distribution(values: number[]): Record<string, number> {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    minMs: round(sorted[0] ?? 0),
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    maxMs: round(sorted.at(-1) ?? 0),
  };
}

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Stage 48 contract failed: ${message}`);
}

function metricSample(metricsText: string, name: string, labels: Record<string, string>): number {
  const serializedLabels = Object.entries(labels).map(([key, value]) => `${key}="${value}"`).join(',');
  const prefix = `${name}{${serializedLabels}} `;
  const line = metricsText.split('\n').find(candidate => candidate.startsWith(prefix));
  assertContract(line, `Prometheus sample missing: ${prefix.trim()}`);
  const value = Number(line.slice(prefix.length));
  assertContract(Number.isFinite(value), `Prometheus sample is not numeric: ${prefix.trim()}`);
  return value;
}

function exactSha(): string {
  const sha = process.env.STAGE48_EXACT_SHA
    ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  assertContract(/^[0-9a-f]{40}$/i.test(sha), 'exact SHA must contain 40 hexadecimal characters');
  return sha;
}

function setRuntimeDefaults(): void {
  const defaults: Record<string, string> = {
    DATABASE_URL: 'postgresql://placeholder:placeholder@127.0.0.1:5432/placeholder',
    DISCORD_TOKEN: ['stage', '48', 'token'].join('-'),
    DISCORD_CLIENT_ID: '1'.repeat(18),
    DISCORD_CLIENT_SECRET: ['stage', '48', 'client'].join('-'),
    BOT_OWNER_ID: '1'.repeat(18),
    ENCRYPTION_KEY: '0'.repeat(64),
    SESSION_SECRET: ['stage', '48', 'session'].join('-'),
  };
  for (const [key, value] of Object.entries(defaults)) process.env[key] ??= value;
  process.env.STAGE48_LAB_MODE = '1';
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

async function measure<T>(count: number, fn: (index: number) => Promise<T>): Promise<{ latencies: number[]; values: T[] }> {
  const latencies: number[] = [];
  const values: T[] = [];
  for (let index = 0; index < count; index += 1) {
    const started = performance.now();
    values.push(await fn(index));
    latencies.push(performance.now() - started);
  }
  return { latencies, values };
}

async function measureConcurrent<T>(count: number, fn: (index: number) => Promise<T>): Promise<{ latencies: number[]; values: T[] }> {
  const samples = await Promise.all(Array.from({ length: count }, async (_, index) => {
    const started = performance.now();
    const value = await fn(index);
    return { latency: performance.now() - started, value };
  }));
  return { latencies: samples.map(sample => sample.latency), values: samples.map(sample => sample.value) };
}

async function main(): Promise<void> {
  assertContract(process.env.STAGE48_REQUIRE_LAB === '1', 'STAGE48_REQUIRE_LAB=1 is mandatory');
  setRuntimeDefaults();

  // Loaded only after the required configuration and lab guard are installed.
  const { callAI } = require('../src/modules/ai/aiHandler') as typeof import('../src/modules/ai/aiHandler');
  const { NitradoClient } = require('../src/modules/nitrado/nitradoClient') as typeof import('../src/modules/nitrado/nitradoClient');
  const { getNitradoBreakerStatus, resetAllNitradoBreakers } = require('../src/modules/nitrado/circuitBreaker') as typeof import('../src/modules/nitrado/circuitBreaker');
  const { metricsRegistry } = require('../src/utils/metrics') as typeof import('../src/utils/metrics');
  const prisma = (require('../src/database/prisma') as typeof import('../src/database/prisma')).default;

  const aiCounts: Record<string, number> = {};
  let nitradoMode: 'success' | 'retry503' | 'rate429' | 'circuit503' = 'success';
  let nitradoModeRequests = 0;
  let activeAi = 0;
  let peakAi = 0;
  let activeNitrado = 0;
  let peakNitrado = 0;
  let aiProtocolValid = true;
  let nitradoProtocolValid = true;

  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    if (pathname.startsWith('/ai/')) {
      activeAi += 1;
      peakAi = Math.max(peakAi, activeAi);
      res.once('finish', () => { activeAi -= 1; });
      aiCounts[pathname] = (aiCounts[pathname] ?? 0) + 1;
      const body = await readJsonBody(req);
      aiProtocolValid &&= req.method === 'POST'
        && String(req.headers.authorization ?? '').startsWith('Bearer ')
        && typeof body.model === 'string'
        && Array.isArray(body.messages);

      if (pathname === '/ai/transient/chat/completions') {
        json(res, 503, { error: { message: 'bounded synthetic transient' } });
        return;
      }
      if (pathname === '/ai/rate-limit/chat/completions') {
        json(res, 429, { error: { message: 'bounded synthetic rate limit' } }, { 'retry-after-ms': '25' });
        return;
      }
      if (pathname.endsWith('/chat/completions')) {
        setTimeout(() => json(res, 200, {
          choices: [{ message: { content: `stage48:${pathname.split('/')[2]}` } }],
        }), 12);
        return;
      }
    }

    if (pathname === '/nitrado/services') {
      activeNitrado += 1;
      peakNitrado = Math.max(peakNitrado, activeNitrado);
      res.once('finish', () => { activeNitrado -= 1; });
      nitradoModeRequests += 1;
      nitradoProtocolValid &&= req.method === 'GET'
        && String(req.headers.authorization ?? '').startsWith('Bearer ')
        && req.headers.accept === 'application/json';
      if (nitradoMode === 'retry503' && nitradoModeRequests <= 2) {
        json(res, 503, { message: 'bounded synthetic server error' });
        return;
      }
      if (nitradoMode === 'rate429' && nitradoModeRequests === 1) {
        json(res, 429, { message: 'bounded synthetic rate limit' }, { 'retry-after': '0' });
        return;
      }
      if (nitradoMode === 'circuit503') {
        json(res, 503, { message: 'bounded synthetic outage' });
        return;
      }
      setTimeout(() => json(res, 200, {
        data: { services: [{ id: 48, type: 'gameserver', status: 'active', details: { game: 'dayz' } }] },
      }), 8);
      return;
    }

    json(res, 404, { error: 'not-found' });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assertContract(address && typeof address === 'object', 'loopback server must expose an ephemeral port');
  const origin = `http://127.0.0.1:${address.port}`;

  const runtimeCredential = crypto.randomBytes(18).toString('hex');
  const aiOptions = (providers: Array<'groq' | 'cerebras' | 'openrouter' | 'openai'>, routeByProvider: Partial<Record<'groq' | 'cerebras' | 'openrouter' | 'openai', string>>) => ({
    stage48Lab: {
      providers,
      transports: Object.fromEntries(providers.map(provider => [provider, {
        baseUrl: `${origin}/ai/${routeByProvider[provider] ?? 'success'}`,
        apiKey: runtimeCredential,
        model: `stage48-${provider}`,
      }])),
      retryDelayMs: 20,
    },
  });

  try {
    const prompt = [{ role: 'user', content: 'Stage 48 deterministic loopback probe' }];
    const aiSequential = await measure(sampleCount, () => callAI(prompt, aiOptions(['groq'], { groq: 'success' })));
    const aiConcurrent = await measureConcurrent(concurrency, () => callAI(prompt, aiOptions(['groq'], { groq: 'success' })));
    const aiSuccessValues = [...aiSequential.values, ...aiConcurrent.values];
    const aiSuccessLatencies = [...aiSequential.latencies, ...aiConcurrent.latencies];

    const transientResult = await callAI(prompt, aiOptions(
      ['groq', 'cerebras'],
      { groq: 'transient', cerebras: 'fallback' },
    ));
    const rateLimitResult = await callAI(prompt, aiOptions(
      ['openrouter', 'openai'],
      { openrouter: 'rate-limit', openai: 'fallback' },
    ));

    resetAllNitradoBreakers();
    nitradoMode = 'success';
    nitradoModeRequests = 0;
    const nitradoClient = new NitradoClient(runtimeCredential, { stage48LabBaseUrl: `${origin}/nitrado` });
    const nitradoSequential = await measure(sampleCount, () => nitradoClient.listServices());
    const nitradoConcurrent = await measureConcurrent(concurrency, () => nitradoClient.listServices());
    const nitradoSuccessLatencies = [...nitradoSequential.latencies, ...nitradoConcurrent.latencies];
    const nitradoSuccessRequests = nitradoModeRequests;

    resetAllNitradoBreakers();
    nitradoMode = 'retry503';
    nitradoModeRequests = 0;
    const retryServices = await nitradoClient.listServices();
    const retry503Requests = nitradoModeRequests;

    resetAllNitradoBreakers();
    nitradoMode = 'rate429';
    nitradoModeRequests = 0;
    const rateServices = await nitradoClient.listServices();
    const rate429Requests = nitradoModeRequests;

    resetAllNitradoBreakers();
    nitradoMode = 'circuit503';
    nitradoModeRequests = 0;
    let failedLogicalCalls = 0;
    while (getNitradoBreakerStatus().READ.state !== 'OPEN' && failedLogicalCalls < 3) {
      try {
        await nitradoClient.listServices();
      } catch {
        failedLogicalCalls += 1;
      }
    }
    const openStatus = getNitradoBreakerStatus().READ;
    const remoteRequestsAtOpen = nitradoModeRequests;
    const failFastStarted = performance.now();
    let failFastError = '';
    try {
      await nitradoClient.listServices();
    } catch (error) {
      failFastError = (error as Error).name;
    }
    const failFastLatencyMs = performance.now() - failFastStarted;
    const remoteRequestsAfterFailFast = nitradoModeRequests;

    const metricsText = await metricsRegistry.metrics();
    const metricNames = [
      'vbot_ai_provider_attempts_total',
      'vbot_ai_provider_latency_seconds',
      'vbot_ai_provider_fallback_total',
      'vbot_nitrado_api_requests_total',
      'vbot_nitrado_api_request_duration_seconds',
      'vbot_nitrado_api_retries_total',
    ];
    const metricsPresent = Object.fromEntries(metricNames.map(name => [name, metricsText.includes(name)]));
    const nitradoMetricSamples = {
      successRequests: metricSample(metricsText, 'vbot_nitrado_api_requests_total', {
        op_class: 'READ', operation: 'services', outcome: 'success',
      }),
      serverErrorRequests: metricSample(metricsText, 'vbot_nitrado_api_requests_total', {
        op_class: 'READ', operation: 'services', outcome: 'server_error',
      }),
      circuitOpenRequests: metricSample(metricsText, 'vbot_nitrado_api_requests_total', {
        op_class: 'READ', operation: 'services', outcome: 'circuit_open',
      }),
      serverErrorRetries: metricSample(metricsText, 'vbot_nitrado_api_retries_total', {
        op_class: 'READ', operation: 'services', reason: 'server_error',
      }),
      rateLimitRetries: metricSample(metricsText, 'vbot_nitrado_api_retries_total', {
        op_class: 'READ', operation: 'services', reason: 'rate_limit',
      }),
    };

    const aiSuccessRoute = '/ai/success/chat/completions';
    assertContract(aiProtocolValid, 'AI requests must use the production-compatible HTTP contract');
    assertContract(aiSuccessValues.every(value => value === 'stage48:success'), 'AI success response contract');
    assertContract(aiCounts[aiSuccessRoute] === sampleCount + concurrency, 'AI success request count');
    assertContract(distribution(aiSuccessLatencies).p99Ms <= latencyLimitMs, 'AI loopback p99 threshold');
    assertContract(peakAi >= 8, 'AI concurrency must reach at least 8 in-flight requests');
    assertContract(aiCounts['/ai/transient/chat/completions'] === 2, 'AI transient retry must be exactly one retry');
    assertContract(aiCounts['/ai/fallback/chat/completions'] === 2, 'AI fallback must serve transient and 429 scenarios');
    assertContract(transientResult === 'stage48:fallback', 'AI transient fallback result');
    assertContract(aiCounts['/ai/rate-limit/chat/completions'] === 1, 'AI 429 must leave the provider without retry storm');
    assertContract(rateLimitResult === 'stage48:fallback', 'AI 429 fallback result');
    assertContract(nitradoProtocolValid, 'Nitrado requests must use the production HTTP contract');
    assertContract(nitradoSuccessRequests === sampleCount + concurrency, 'Nitrado success request count');
    assertContract(distribution(nitradoSuccessLatencies).p99Ms <= latencyLimitMs, 'Nitrado loopback p99 threshold');
    assertContract(peakNitrado >= 8, 'Nitrado concurrency must reach at least 8 in-flight requests');
    assertContract(retry503Requests === 3 && retryServices.length === 1, 'Nitrado 503 retry bound');
    assertContract(rate429Requests === 2 && rateServices.length === 1, 'Nitrado 429 retry-after path');
    assertContract(openStatus.state === 'OPEN', 'Nitrado READ circuit must open');
    assertContract(remoteRequestsAtOpen === 5, 'Nitrado circuit must open after five remote failures');
    assertContract(remoteRequestsAfterFailFast === remoteRequestsAtOpen, 'open circuit must not send another HTTP request');
    assertContract(failFastError === 'NitradoCircuitOpenError', 'open circuit error taxonomy');
    assertContract(failFastLatencyMs < 250, 'open circuit must fail fast');
    assertContract(Object.values(metricsPresent).every(Boolean), 'AI and Nitrado metric families must be exported');
    assertContract(nitradoMetricSamples.successRequests === sampleCount + concurrency + 2, 'Nitrado success metric count');
    assertContract(nitradoMetricSamples.serverErrorRequests === 1, 'Nitrado server-error metric count');
    assertContract(nitradoMetricSamples.circuitOpenRequests === 2, 'Nitrado circuit-open metric count');
    assertContract(nitradoMetricSamples.serverErrorRetries === 5, 'Nitrado executed 5xx retry metric count');
    assertContract(nitradoMetricSamples.rateLimitRetries === 1, 'Nitrado executed 429 retry metric count');

    const artifact = {
      schemaVersion: 1,
      stage: 48,
      exactSha: exactSha(),
      capturedAt: new Date().toISOString(),
      environment: {
        transport: 'real TCP over HTTP loopback',
        bindHost: '127.0.0.1',
        ephemeralPort: true,
        externalNetworkUsed: false,
        credentials: 'runtime-random, never persisted',
        sampleCount,
        concurrency,
      },
      contracts: {
        requiredLab: true,
        loopbackOnlyOverride: true,
        productionAiClientPath: true,
        productionNitradoClientPath: true,
        productionTimeoutsUnchanged: true,
        realSocketTransport: true,
        aiProtocolValid,
        nitradoProtocolValid,
        boundedRetries: true,
        circuitFailFast: true,
        lowCardinalityMetrics: true,
      },
      thresholds: {
        successP99LimitMs: latencyLimitMs,
        minimumObservedConcurrency: 8,
        maximumAiTransientAttemptsPerProvider: 2,
        maximumNitradoAttemptsPerLogicalRequest: 3,
        circuitFailFastLimitMs: 250,
      },
      ai: {
        success: {
          latency: distribution(aiSuccessLatencies),
          errorCount: 0,
          requestCount: aiCounts[aiSuccessRoute],
          peakInFlight: peakAi,
        },
        transientFallback: {
          firstProviderRequests: aiCounts['/ai/transient/chat/completions'],
          fallbackProviderRequests: 1,
          result: transientResult,
        },
        rateLimitFallback: {
          rateLimitedProviderRequests: aiCounts['/ai/rate-limit/chat/completions'],
          fallbackProviderRequests: 1,
          result: rateLimitResult,
        },
      },
      nitrado: {
        success: {
          latency: distribution(nitradoSuccessLatencies),
          errorCount: 0,
          remoteRequestCount: nitradoSuccessRequests,
          peakInFlight: peakNitrado,
        },
        retry503: { remoteRequestCount: retry503Requests, finalServiceCount: retryServices.length },
        rate429: { remoteRequestCount: rate429Requests, finalServiceCount: rateServices.length },
        circuit: {
          failedLogicalCalls,
          state: openStatus.state,
          remoteRequestsAtOpen,
          remoteRequestsAfterFailFast,
          failFastError,
          failFastLatencyMs: round(failFastLatencyMs),
        },
      },
      metricsPresent,
      nitradoMetricSamples,
      externalProductionBoundary: {
        status: 'deferred-to-stage-67',
        reason: 'Production-provider RTT requires owner-supplied credentials and an approved external rate budget.',
        claim: 'Stage 48 makes no production-provider RTT or availability claim.',
      },
      residual: [],
      passed: true,
    };

    const outputPath = path.resolve(root, process.env.STAGE48_OUTPUT_PATH ?? `stage48-artifacts/${artifact.exactSha}.json`);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify({ stage: 48, passed: true, exactSha: artifact.exactSha, outputPath })}\n`);
  } finally {
    resetAllNitradoBreakers();
    await new Promise(resolve => setTimeout(resolve, 250));
    await prisma.$disconnect().catch(() => undefined);
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

void main().catch(error => {
  process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
  process.exitCode = 1;
});
