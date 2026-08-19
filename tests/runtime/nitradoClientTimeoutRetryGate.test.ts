import fs from 'node:fs';
import path from 'node:path';

const client = fs.readFileSync(
  path.resolve(process.cwd(), 'src/modules/nitrado/nitradoClient.ts'),
  'utf8',
);

describe('Nitrado-1V canonical client timeout/retry architecture gate', () => {
  it('retryt GET-Timeouts bounded, replayt ambige WRITE-Timeouts aber nicht sofort', () => {
    const request = client.indexOf('private async request<T>(');
    const catchBlock = client.indexOf('lastErr = e instanceof Error ? e : new Error(String(e));', request);
    const policy = client.indexOf("const retryableTransport = method === 'GET' || (e as AxiosError).code !== 'ECONNABORTED';", catchBlock);
    const boundedRetry = client.indexOf('if (attempt < 3 && retryableTransport) {', policy);
    const backoff = client.indexOf('await sleep(500 * Math.pow(2, attempt - 1));', boundedRetry);

    expect(request).toBeGreaterThanOrEqual(0);
    expect(catchBlock).toBeGreaterThan(request);
    expect(policy).toBeGreaterThan(catchBlock);
    expect(boundedRetry).toBeGreaterThan(policy);
    expect(backoff).toBeGreaterThan(boundedRetry);
  });

  it('haertet den signierten Download-/Seek-Hop fuer 429, 5xx und Transportfehler', () => {
    const helper = client.indexOf('private async fetchSignedText(');
    const rateLimit = client.indexOf('if (status === 429) {', helper);
    const preserve429 = client.indexOf("new NitradoApiError('Signed Download Rate-Limit (429) nach mehreren Versuchen', 429, 'file_server')", rateLimit);
    const serverRetry = client.indexOf('if (status >= 500 && attempt < 3) {', preserve429);
    const transportRetry = client.indexOf('if (attempt < 3) {', serverRetry);
    const finalError = client.indexOf("new NitradoApiError(lastErr?.message ?? 'Signed Download fehlgeschlagen', null, 'file_server')", transportRetry);

    expect(helper).toBeGreaterThanOrEqual(0);
    expect(rateLimit).toBeGreaterThan(helper);
    expect(preserve429).toBeGreaterThan(rateLimit);
    expect(serverRetry).toBeGreaterThan(preserve429);
    expect(transportRetry).toBeGreaterThan(serverRetry);
    expect(finalError).toBeGreaterThan(transportRetry);
  });

  it('bewahrt permanente 4xx als sofortigen NitradoApiError statt sie blind zu retryen', () => {
    const helper = client.indexOf('private async fetchSignedText(');
    const statusBranch = client.indexOf('if (status !== null) {', helper);
    const serverRetry = client.indexOf('if (status >= 500 && attempt < 3) {', statusBranch);
    const permanentThrow = client.indexOf("throw new NitradoApiError(lastErr.message || `HTTP ${status}`, status, 'file_server');", serverRetry);

    expect(statusBranch).toBeGreaterThan(helper);
    expect(serverRetry).toBeGreaterThan(statusBranch);
    expect(permanentThrow).toBeGreaterThan(serverRetry);
  });
});
