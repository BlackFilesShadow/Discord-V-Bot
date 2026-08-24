import fs from 'node:fs';
import { normalizeSourceNewlines } from '../helpers/sourceText';
import path from 'node:path';

const read = (relative: string): string => normalizeSourceNewlines(fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8'));

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

  it('closes reachable non-429 4xx probes without counting them as breaker failures', () => {
    const source = read('src/modules/nitrado/nitradoClient.ts');
    const serverError = source.indexOf('if (res.status >= 500) {');
    const clientErrorPath = source.indexOf(
      "        breaker.recordSuccess();\n        throw new NitradoApiError(",
      serverError,
    );
    const catchBlock = source.indexOf('      } catch (e) {', clientErrorPath);

    expect(serverError).toBeGreaterThanOrEqual(0);
    expect(clientErrorPath).toBeGreaterThan(serverError);
    expect(catchBlock).toBeGreaterThan(clientErrorPath);
    expect(source.slice(clientErrorPath, catchBlock)).not.toContain('breaker.recordFailure();');
  });
});
