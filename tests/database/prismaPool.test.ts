import { ensureConnectionPoolParams } from '../../src/database/prisma';

describe('ensureConnectionPoolParams', () => {
  it('haengt connection_limit + pool_timeout an wenn nicht gesetzt', () => {
    const result = ensureConnectionPoolParams('postgresql://u:p@h:5432/db');
    expect(result).toContain('connection_limit=10');
    expect(result).toContain('pool_timeout=20');
  });

  it('respektiert vorhandene connection_limit', () => {
    const result = ensureConnectionPoolParams('postgresql://u:p@h:5432/db?connection_limit=5');
    expect(result).toContain('connection_limit=5');
    expect(result).toContain('pool_timeout=20');
    expect(result).not.toContain('connection_limit=10');
  });

  it('respektiert vorhandenes pool_timeout', () => {
    const result = ensureConnectionPoolParams('postgresql://u:p@h:5432/db?pool_timeout=60');
    expect(result).toContain('pool_timeout=60');
    expect(result).toContain('connection_limit=10');
  });

  it('null/undefined-safe', () => {
    expect(ensureConnectionPoolParams(undefined)).toBeUndefined();
  });

  it('gibt nicht-parsebare URLs unveraendert zurueck', () => {
    const weird = 'not-a-valid-url';
    expect(ensureConnectionPoolParams(weird)).toBe(weird);
  });
});
