import {
  quoteIdentifier,
  runDatabaseConsistencyScan,
  type ConsistencyQueryClient,
} from '../../src/database/consistencyScanner';

describe('DB-3 database consistency scanner', () => {
  test('quotes metadata-derived SQL identifiers safely', () => {
    expect(quoteIdentifier('normal')).toBe('"normal"');
    expect(quoteIdentifier('bad"name')).toBe('"bad""name"');
  });

  test('reports FK, gameserver-scope and semantic corruption as INVALID without repairing it', async () => {
    const query = jest.fn(async (sql: string): Promise<unknown> => {
      if (sql.includes('FROM pg_constraint')) {
        return [{
          constraintName: 'Child_parentId_fkey',
          childSchema: 'public',
          childTable: 'Child',
          parentSchema: 'public',
          parentTable: 'Parent',
          validated: false,
          childColumnsJson: '["parentId"]',
          parentColumnsJson: '["id"]',
        }];
      }
      if (sql.includes('information_schema.columns')) {
        return [{ tableSchema: 'public', tableName: 'ScopedChild' }];
      }
      if (sql.includes('FROM "public"."Child" child')) return [{ count: '2' }];
      if (sql.includes('FROM "public"."ScopedChild" scoped')) return [{ count: '3' }];
      if (sql.includes('FROM "GameIdentityLink"')) return [{ count: '1' }];
      return [{ count: '0' }];
    });
    const client = { $queryRawUnsafe: query } as unknown as ConsistencyQueryClient;

    const report = await runDatabaseConsistencyScan(client);

    expect(report.status).toBe('INVALID');
    expect(report.scannedForeignKeys).toBe(1);
    expect(report.scannedGameserverTables).toBe(1);
    expect(report.findings.map((finding) => finding.code)).toEqual(expect.arrayContaining([
      'FK_NOT_VALIDATED',
      'FK_ORPHAN',
      'GAMESERVER_SCOPE_MISMATCH',
      'GAME_IDENTITY_VERIFIED_INCOMPLETE',
    ]));
    expect(query.mock.calls.some(([sql]) => /\b(?:UPDATE|DELETE|INSERT|ALTER)\b/i.test(String(sql)))).toBe(false);
  });

  test('returns CLEAN when every invariant query has zero findings', async () => {
    const query = jest.fn(async (sql: string): Promise<unknown> => {
      if (sql.includes('FROM pg_constraint')) return [];
      if (sql.includes('information_schema.columns')) return [];
      return [{ count: '0' }];
    });
    const client = { $queryRawUnsafe: query } as unknown as ConsistencyQueryClient;

    const report = await runDatabaseConsistencyScan(client);

    expect(report.status).toBe('CLEAN');
    expect(report.findings).toEqual([]);
    expect(report.scannedForeignKeys).toBe(0);
    expect(report.scannedGameserverTables).toBe(0);
  });
});
