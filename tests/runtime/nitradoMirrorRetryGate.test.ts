import fs from 'node:fs';
import path from 'node:path';

const readClient = fs.readFileSync(
  path.resolve(process.cwd(), 'src/modules/nitrado/mirror/readClient.ts'),
  'utf8',
);

describe('Nitrado-1L mirror retry architecture gate', () => {
  it('haelt Retry-After bounded und versteht Sekunden sowie HTTP-Datum', () => {
    expect(readClient).toContain('const RETRY_AFTER_CAP_MS = 30_000;');
    expect(readClient).toContain('export function parseMirrorRetryAfterMs(');
    expect(readClient).toContain('const asSeconds = Number(raw);');
    expect(readClient).toContain('const at = Date.parse(raw);');
    expect(readClient).toContain('return Math.min(ms, Math.max(0, capMs));');
    expect(readClient).not.toContain("Number(res.headers['retry-after']) || 2");
  });

  it('bewahrt dauerhaftes 429 im API-GET als echten NitradoReadError-Status', () => {
    const getJson = readClient.indexOf('private async getJson<T>(');
    const rateLimit = readClient.indexOf('if (res.status === 429) {', getJson);
    const finalAttempt = readClient.indexOf('if (attempt >= MAX_ATTEMPTS) {', rateLimit);
    const statusPreserved = readClient.indexOf("new NitradoReadError('Rate-Limit (429) nach mehreren Versuchen', 429, path)", finalAttempt);
    const retrySleep = readClient.indexOf("await sleep(parseMirrorRetryAfterMs(res.headers['retry-after']));", statusPreserved);

    expect(getJson).toBeGreaterThanOrEqual(0);
    expect(rateLimit).toBeGreaterThan(getJson);
    expect(finalAttempt).toBeGreaterThan(rateLimit);
    expect(statusPreserved).toBeGreaterThan(finalAttempt);
    expect(retrySleep).toBeGreaterThan(statusPreserved);
  });

  it('retryt Transportfehler inklusive Timeout bounded statt ECONNABORTED auszusparen', () => {
    expect(readClient).not.toContain("code !== 'ECONNABORTED'");

    const getJson = readClient.indexOf('private async getJson<T>(');
    const catchBlock = readClient.indexOf('lastErr = e instanceof Error ? e : new Error(String(e));', getJson);
    const boundedRetry = readClient.indexOf('if (attempt < MAX_ATTEMPTS) {', catchBlock);
    const backoff = readClient.indexOf('await sleep(retryBackoffMs(attempt));', boundedRetry);

    expect(catchBlock).toBeGreaterThan(getJson);
    expect(boundedRetry).toBeGreaterThan(catchBlock);
    expect(backoff).toBeGreaterThan(boundedRetry);
  });

  it('haertet auch den signierten Download-Hop mit derselben bounded Taxonomie', () => {
    const helper = readClient.indexOf('private async downloadSignedBuffer(');
    const rateLimit = readClient.indexOf('if (res.status === 429) {', helper);
    const preserved = readClient.indexOf("new NitradoReadError('Download Rate-Limit (429) nach mehreren Versuchen', 429, fullPath)", rateLimit);
    const serverRetry = readClient.indexOf('if (res.status >= 500 && attempt < MAX_ATTEMPTS) {', preserved);
    const transportRetry = readClient.indexOf('if (attempt < MAX_ATTEMPTS) {', serverRetry);
    const caller = readClient.indexOf('return this.downloadSignedBuffer(url, fullPath, maxBytes);', helper);

    expect(helper).toBeGreaterThanOrEqual(0);
    expect(rateLimit).toBeGreaterThan(helper);
    expect(preserved).toBeGreaterThan(rateLimit);
    expect(serverRetry).toBeGreaterThan(preserved);
    expect(transportRetry).toBeGreaterThan(serverRetry);
    expect(caller).toBeGreaterThan(helper);
  });

  it('laesst die bestehende read-only Grenze unangetastet', () => {
    expect(readClient).toContain("method: 'GET'");
    expect(readClient).not.toMatch(/method\s*:\s*['"](?:POST|PUT|PATCH|DELETE)['"]/i);
    expect(readClient).not.toMatch(/from\s+['"][^'"]*nitradoClient['"]/);
  });
});
