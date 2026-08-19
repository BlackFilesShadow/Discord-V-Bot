import fs from 'node:fs';
import path from 'node:path';

const clientSource = fs.readFileSync(
  path.resolve(process.cwd(), 'src/modules/nitrado/nitradoClient.ts'),
  'utf8',
);

describe('Nitrado-1W signed FileServer retry architecture gate', () => {
  it('keeps a dedicated bounded retry loop around the signed axios.get hop', () => {
    const start = clientSource.indexOf('private async fetchSignedText');
    const end = clientSource.indexOf('async downloadFile(', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const body = clientSource.slice(start, end);

    expect(body).toContain('for (let attempt = 1; attempt <= 3; attempt++)');
    expect(body).toContain('axios.get<string>(meta.url');
    expect(body).toContain('status === 429');
    expect(body).toContain('status >= 500 && attempt < 3');
    expect(body).toContain("new NitradoApiError(lastErr.message || `HTTP ${status}`, status, 'file_server')");
    expect(body).toContain("new NitradoApiError(lastErr?.message ?? 'Signed Download fehlgeschlagen', null, 'file_server')");
  });

  it('preserves byte ceilings and never logs signed token/url data', () => {
    expect(clientSource).toContain('maxContentLength: maxBytes');
    expect(clientSource).toContain('maxBodyLength: maxBytes');
    expect(clientSource).not.toMatch(/logger\.(?:info|warn|error|debug)\([^\n]*(?:meta\.token|meta\.url)/);
  });
});
