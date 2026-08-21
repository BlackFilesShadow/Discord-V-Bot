import fs from 'node:fs';
import { normalizeSourceNewlines } from '../helpers/sourceText';
import path from 'node:path';

const source = normalizeSourceNewlines(fs.readFileSync(
  path.resolve(process.cwd(), 'src/modules/nitrado/nitradoClient.ts'),
  'utf8',
));

describe('Nitrado-1V core client retry architecture gate', () => {
  it('counts terminal 5xx failures before deciding whether another retry exists', () => {
    const serverError = source.indexOf('if (res.status >= 500) {');
    const breakerFailure = source.indexOf('breaker.recordFailure();', serverError);
    const retryBranch = source.indexOf('if (attempt < 3) {', breakerFailure);
    const terminalThrow = source.indexOf('throw new NitradoApiError(', retryBranch);

    expect(serverError).toBeGreaterThanOrEqual(0);
    expect(breakerFailure).toBeGreaterThan(serverError);
    expect(retryBranch).toBeGreaterThan(breakerFailure);
    expect(terminalThrow).toBeGreaterThan(retryBranch);
  });

  it('keeps transport and Axios timeout errors on the same bounded three-attempt path', () => {
    const catchStart = source.indexOf('} catch (e) {');
    const failure = source.indexOf('breaker.recordFailure();', catchStart);
    const retry = source.indexOf('if (attempt < 3) {', failure);
    const catchEnd = source.indexOf('\n      }\n    }\n    throw new NitradoApiError', retry);
    const catchBlock = source.slice(catchStart, catchEnd);

    expect(catchStart).toBeGreaterThanOrEqual(0);
    expect(failure).toBeGreaterThan(catchStart);
    expect(retry).toBeGreaterThan(failure);
    expect(catchBlock).not.toContain("ECONNABORTED");
    expect(source).toContain('for (let attempt = 1; attempt <= 3; attempt++)');
  });

  it('keeps non-429 4xx outside breaker failure accounting', () => {
    const serverError = source.indexOf('if (res.status >= 500) {');
    const genericThrow = source.indexOf('throw new NitradoApiError(', source.indexOf('}', serverError));
    const tail = source.slice(genericThrow, source.indexOf('} catch (e) {', genericThrow));

    expect(genericThrow).toBeGreaterThan(serverError);
    expect(tail).not.toContain('breaker.recordFailure()');
  });
});
