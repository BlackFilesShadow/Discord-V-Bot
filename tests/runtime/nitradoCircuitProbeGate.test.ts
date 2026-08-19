import fs from 'node:fs';
import path from 'node:path';

const read = (relative: string): string => fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8');

describe('Nitrado-1V circuit probe/retry architecture gate', () => {
  it('allows exactly one caller to own HALF_OPEN and blocks every concurrent caller until resolution', () => {
    const source = read('src/modules/nitrado/circuitBreaker.ts');
    const preflight = source.indexOf('preflight(): void {');
    const halfOpenTransition = source.indexOf("this.state = 'HALF_OPEN';", preflight);
    const halfOpenBlock = source.indexOf('throw new NitradoCircuitOpenError(HALF_OPEN_PROBE_RETRY_MS);', halfOpenTransition);

    expect(preflight).toBeGreaterThanOrEqual(0);
    expect(halfOpenTransition).toBeGreaterThan(preflight);
    expect(halfOpenBlock).toBeGreaterThan(halfOpenTransition);
    expect(source).toContain('nach `cooldownMs` exakt einen Probe-Call zulassen');
  });

  it('runs circuit preflight before every actual HTTP retry instead of once per logical request', () => {
    const source = read('src/modules/nitrado/nitradoClient.ts');
    const requestStart = source.indexOf('private async request<T>');
    const loop = source.indexOf('for (let attempt = 1; attempt <= 3; attempt++) {', requestStart);
    const preflight = source.indexOf('breaker.preflight();', loop);
    const httpCall = source.indexOf('await this.http.request({ method, url: path, ...opts });', preflight);

    expect(requestStart).toBeGreaterThanOrEqual(0);
    expect(loop).toBeGreaterThan(requestStart);
    expect(preflight).toBeGreaterThan(loop);
    expect(httpCall).toBeGreaterThan(preflight);
    expect(source.slice(requestStart, loop)).not.toContain('breaker.preflight();');
  });

  it('counts terminal 5xx and treats non-429 4xx as reachable-server probe success', () => {
    const source = read('src/modules/nitrado/nitradoClient.ts');
    const serverError = source.indexOf('if (res.status >= 500) {');
    const failure = source.indexOf('breaker.recordFailure();', serverError);
    const retryDecision = source.indexOf('if (attempt < 3) {', failure);
    const clientErrorComment = source.indexOf('Nicht-retrybare 4xx<>429', retryDecision);
    const success = source.indexOf('breaker.recordSuccess();', clientErrorComment);
    const clientError = source.indexOf('throw new NitradoApiError(', success);

    expect(serverError).toBeGreaterThanOrEqual(0);
    expect(failure).toBeGreaterThan(serverError);
    expect(retryDecision).toBeGreaterThan(failure);
    expect(clientErrorComment).toBeGreaterThan(retryDecision);
    expect(success).toBeGreaterThan(clientErrorComment);
    expect(clientError).toBeGreaterThan(success);
  });
});
