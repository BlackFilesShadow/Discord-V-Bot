import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(
  path.resolve(process.cwd(), 'src/modules/nitrado/nitradoClient.ts'),
  'utf8',
);

function expectOrdered(body: string, anchors: string[]): void {
  let previous = -1;
  for (const anchor of anchors) {
    const next = body.indexOf(anchor, previous + 1);
    expect(next).toBeGreaterThan(previous);
    previous = next;
  }
}

describe('Nitrado-1W signed download retry architecture gate', () => {
  const start = source.indexOf('private async fetchSignedText(');
  const end = source.indexOf('\n  async downloadFile(', start);
  const body = source.slice(start, end);

  it('keeps the signed hop bounded and converts HTTP statuses into NitradoApiError', () => {
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expectOrdered(body, [
      'for (let attempt = 1; attempt <= 3; attempt++) {',
      'await axios.get<string>(meta.url',
      'validateStatus: () => true',
      'if (res.status === 429)',
      "parseRetryAfterMs(res.headers['retry-after'])",
      'if (res.status >= 500 && attempt < 3)',
      'throw new NitradoApiError(`Download HTTP ${res.status}`',
      '} catch (e) {',
      'if (e instanceof NitradoApiError) throw e;',
      'if (attempt < 3)',
      "throw new NitradoApiError(lastErr?.message ?? 'Download fehlgeschlagen', null, fullPath)",
    ]);
  });

  it('does not couple a signed CDN/FileServer failure to the global Nitrado READ circuit', () => {
    expect(body).not.toContain('getNitradoBreaker(');
    expect(body).not.toContain('breaker.recordFailure()');
    expect(body).not.toContain('breaker.recordSuccess()');
  });

  it('binds both full download and seek range errors to the local file path without exposing the signed URL', () => {
    const downloadStart = source.indexOf('async downloadFile(serviceId: string, fullPath: string)');
    const rangeStart = source.indexOf('async downloadFileRange(', downloadStart);
    const restartStart = source.indexOf('async restart(', rangeStart);
    const downloadBody = source.slice(downloadStart, rangeStart);
    const rangeBody = source.slice(rangeStart, restartStart);

    expect(downloadBody).toContain('this.fetchSignedText(token, MAX_DOWNLOAD_BYTES, fullPath)');
    expect(rangeBody).toContain('this.fetchSignedText(token, Math.min(length + 4096, MAX_SEEK_BYTES), fullPath)');
    expect(body).not.toContain('NitradoApiError(meta.url');
    expect(body).not.toContain('NitradoApiError(`Download ${meta.url}');
  });
});
