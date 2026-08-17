import prisma from './prisma';

export type DatabaseConsistencySeverity = 'CRITICAL' | 'WARNING';
export type DatabaseConsistencyStatus = 'CLEAN' | 'DEGRADED' | 'INVALID';

export interface DatabaseConsistencyFinding {
  code: string;
  severity: DatabaseConsistencySeverity;
  relation: string;
  count: number;
  message: string;
}

export interface DatabaseConsistencyReport {
  scannedAt: string;
  status: DatabaseConsistencyStatus;
  scannedForeignKeys: number;
  scannedGameserverTables: number;
  findings: DatabaseConsistencyFinding[];
}

export interface ConsistencyQueryClient {
  $queryRawUnsafe<T = unknown>(query: string): Promise<T>;
}

interface ForeignKeyMetadataRow {
  constraintName: string;
  childSchema: string;
  childTable: string;
  parentSchema: string;
  parentTable: string;
  validated: boolean;
  childColumnsJson: string;
  parentColumnsJson: string;
}

interface ScopedTableRow {
  tableSchema: string;
  tableName: string;
}

interface CountRow {
  count: string | number | bigint;
}

interface SemanticCheck {
  code: string;
  severity: DatabaseConsistencySeverity;
  relation: string;
  message: string;
  sql: string;
}

const FOREIGN_KEY_METADATA_SQL = `
SELECT
  con.conname::text AS "constraintName",
  child_ns.nspname::text AS "childSchema",
  child.relname::text AS "childTable",
  parent_ns.nspname::text AS "parentSchema",
  parent.relname::text AS "parentTable",
  con.convalidated AS "validated",
  json_agg(child_att.attname::text ORDER BY key_map.ordinality)::text AS "childColumnsJson",
  json_agg(parent_att.attname::text ORDER BY key_map.ordinality)::text AS "parentColumnsJson"
FROM pg_constraint con
JOIN pg_class child ON child.oid = con.conrelid
JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
JOIN pg_class parent ON parent.oid = con.confrelid
JOIN pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS key_map(attnum, ordinality) ON TRUE
JOIN pg_attribute child_att
  ON child_att.attrelid = child.oid
 AND child_att.attnum = key_map.attnum
JOIN pg_attribute parent_att
  ON parent_att.attrelid = parent.oid
 AND parent_att.attnum = con.confkey[key_map.ordinality]
WHERE con.contype = 'f'
  AND child_ns.nspname = 'public'
GROUP BY
  con.conname,
  child_ns.nspname,
  child.relname,
  parent_ns.nspname,
  parent.relname,
  con.convalidated
ORDER BY child.relname, con.conname;
`;

const GAMESERVER_TABLES_SQL = `
SELECT
  table_schema::text AS "tableSchema",
  table_name::text AS "tableName"
FROM information_schema.columns
WHERE table_schema = 'public'
  AND column_name IN ('guildId', 'nitradoConnId')
GROUP BY table_schema, table_name
HAVING COUNT(DISTINCT column_name) = 2
ORDER BY table_name;
`;

const SEMANTIC_CHECKS: readonly SemanticCheck[] = [
  {
    code: 'GAME_IDENTITY_VERIFIED_INCOMPLETE',
    severity: 'CRITICAL',
    relation: 'GameIdentityLink',
    message: 'VERIFIED-Spielerlinks muessen Identity-Hash und Verifikationszeit besitzen.',
    sql: `
SELECT COUNT(*)::text AS count
FROM "GameIdentityLink"
WHERE "status" = 'VERIFIED'
  AND ("identityHash" IS NULL OR "verifiedAt" IS NULL);
`,
  },
  {
    code: 'PLAYER_SESSION_CONNECT_EVENT_SCOPE',
    severity: 'CRITICAL',
    relation: 'PlayerSession -> AdmEvent(connect)',
    message: 'Jede PlayerSession muss auf ein Connect-Event desselben Guild-/Gameserver-Scopes zeigen.',
    sql: `
SELECT COUNT(*)::text AS count
FROM "PlayerSession" session
LEFT JOIN "AdmEvent" event
  ON event."id" = session."connectEventId"
 AND event."guildId" = session."guildId"
 AND event."nitradoConnId" = session."nitradoConnId"
WHERE event."id" IS NULL;
`,
  },
  {
    code: 'PLAYER_SESSION_DISCONNECT_EVENT_SCOPE',
    severity: 'CRITICAL',
    relation: 'PlayerSession -> AdmEvent(disconnect)',
    message: 'Gesetzte Disconnect-Events muessen demselben Guild-/Gameserver-Scope wie die Session entsprechen.',
    sql: `
SELECT COUNT(*)::text AS count
FROM "PlayerSession" session
LEFT JOIN "AdmEvent" event
  ON event."id" = session."disconnectEventId"
 AND event."guildId" = session."guildId"
 AND event."nitradoConnId" = session."nitradoConnId"
WHERE session."disconnectEventId" IS NOT NULL
  AND event."id" IS NULL;
`,
  },
  {
    code: 'ECONOMY_MIGRATION_REQUIRED',
    severity: 'CRITICAL',
    relation: 'EconomyScopeMigration',
    message: 'Ungeloeste Economy-Scope-Migrationen sind eine mehrdeutige Produktionswahrheit und muessen explizit aufgeloest werden.',
    sql: `
SELECT COUNT(*)::text AS count
FROM "EconomyScopeMigration"
WHERE "status" = 'MIGRATION_REQUIRED';
`,
  },
  {
    code: 'ECONOMY_RESOLVED_NULL_SCOPE',
    severity: 'CRITICAL',
    relation: 'Economy -> NitradoConnection',
    message: 'Nach aufgeloester Migration duerfen keine serverbezogenen Economy-Zeilen ohne Gameserver-Scope verbleiben.',
    sql: `
SELECT COUNT(*)::text AS count
FROM (
  SELECT e."guildId" FROM "EconomyConfig" e
    JOIN "EconomyScopeMigration" m ON m."guildId" = e."guildId"
    WHERE m."status" = 'RESOLVED' AND e."nitradoConnId" IS NULL
  UNION ALL
  SELECT e."guildId" FROM "EconomyAccount" e
    JOIN "EconomyScopeMigration" m ON m."guildId" = e."guildId"
    WHERE m."status" = 'RESOLVED' AND e."nitradoConnId" IS NULL
  UNION ALL
  SELECT e."guildId" FROM "EconomyTransaction" e
    JOIN "EconomyScopeMigration" m ON m."guildId" = e."guildId"
    WHERE m."status" = 'RESOLVED' AND e."nitradoConnId" IS NULL
  UNION ALL
  SELECT e."guildId" FROM "EconomyLedgerEntry" e
    JOIN "EconomyScopeMigration" m ON m."guildId" = e."guildId"
    WHERE m."status" = 'RESOLVED' AND e."nitradoConnId" IS NULL
  UNION ALL
  SELECT e."guildId" FROM "EconomyRewardRule" e
    JOIN "EconomyScopeMigration" m ON m."guildId" = e."guildId"
    WHERE m."status" = 'RESOLVED' AND e."nitradoConnId" IS NULL
  UNION ALL
  SELECT e."guildId" FROM "BankInterestRun" e
    JOIN "EconomyScopeMigration" m ON m."guildId" = e."guildId"
    WHERE m."status" = 'RESOLVED' AND e."nitradoConnId" IS NULL
  UNION ALL
  SELECT e."guildId" FROM "CasinoGame" e
    JOIN "EconomyScopeMigration" m ON m."guildId" = e."guildId"
    WHERE m."status" = 'RESOLVED' AND e."nitradoConnId" IS NULL
  UNION ALL
  SELECT e."guildId" FROM "CasinoRound" e
    JOIN "EconomyScopeMigration" m ON m."guildId" = e."guildId"
    WHERE m."status" = 'RESOLVED' AND e."nitradoConnId" IS NULL
) broken;
`,
  },
  {
    code: 'CASINO_ROUND_SCOPE_DIVERGENCE',
    severity: 'CRITICAL',
    relation: 'CasinoRound -> CasinoGame',
    message: 'CasinoRound und CasinoGame muessen exakt dieselbe Guild-/Gameserver-Wahrheit tragen.',
    sql: `
SELECT COUNT(*)::text AS count
FROM "CasinoRound" round
JOIN "CasinoGame" game ON game."id" = round."gameId"
WHERE round."guildId" IS DISTINCT FROM game."guildId"
   OR round."nitradoConnId" IS DISTINCT FROM game."nitradoConnId";
`,
  },
];

export function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function qualifiedIdentifier(schema: string, table: string): string {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
}

function parseColumns(value: string, constraintName: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`Ungueltige FK-Spaltenmetadaten fuer ${constraintName}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((entry) => typeof entry !== 'string')) {
    throw new Error(`Ungueltige FK-Spaltenmetadaten fuer ${constraintName}`);
  }
  return parsed as string[];
}

function countFromRows(rows: CountRow[]): number {
  const raw = rows[0]?.count ?? 0;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Ungueltiger Konsistenzscanner-Zaehler: ${String(raw)}`);
  }
  return parsed;
}

async function queryCount(client: ConsistencyQueryClient, sql: string): Promise<number> {
  const rows = await client.$queryRawUnsafe<CountRow[]>(sql);
  return countFromRows(rows);
}

function orphanCountSql(fk: ForeignKeyMetadataRow): string {
  const childColumns = parseColumns(fk.childColumnsJson, fk.constraintName);
  const parentColumns = parseColumns(fk.parentColumnsJson, fk.constraintName);
  if (childColumns.length !== parentColumns.length) {
    throw new Error(`Ungueltige FK-Metadaten fuer ${fk.constraintName}`);
  }

  const join = childColumns
    .map((column, index) => `child.${quoteIdentifier(column)} = parent.${quoteIdentifier(parentColumns[index])}`)
    .join(' AND ');
  const childPresent = childColumns
    .map((column) => `child.${quoteIdentifier(column)} IS NOT NULL`)
    .join(' AND ');

  return `
SELECT COUNT(*)::text AS count
FROM ${qualifiedIdentifier(fk.childSchema, fk.childTable)} child
LEFT JOIN ${qualifiedIdentifier(fk.parentSchema, fk.parentTable)} parent
  ON ${join}
WHERE ${childPresent}
  AND parent.${quoteIdentifier(parentColumns[0])} IS NULL;
`;
}

function gameserverMismatchSql(table: ScopedTableRow): string {
  return `
SELECT COUNT(*)::text AS count
FROM ${qualifiedIdentifier(table.tableSchema, table.tableName)} scoped
LEFT JOIN "public"."NitradoConnection" connection
  ON connection."id" = scoped."nitradoConnId"
 AND connection."guildId" = scoped."guildId"
WHERE scoped."nitradoConnId" IS NOT NULL
  AND connection."id" IS NULL;
`;
}

function reportStatus(findings: DatabaseConsistencyFinding[]): DatabaseConsistencyStatus {
  if (findings.some((finding) => finding.severity === 'CRITICAL')) return 'INVALID';
  if (findings.length > 0) return 'DEGRADED';
  return 'CLEAN';
}

/**
 * DB-3 Produktionsscanner.
 *
 * Read-only by design: Der Scanner diagnostiziert und beendet sich bei
 * Inkonsistenzen fail-closed. Er repariert, loescht, verschiebt oder
 * re-parentet niemals Daten automatisch.
 */
export async function runDatabaseConsistencyScan(
  client: ConsistencyQueryClient = prisma as unknown as ConsistencyQueryClient,
): Promise<DatabaseConsistencyReport> {
  const findings: DatabaseConsistencyFinding[] = [];
  const foreignKeys = await client.$queryRawUnsafe<ForeignKeyMetadataRow[]>(FOREIGN_KEY_METADATA_SQL);

  for (const fk of foreignKeys) {
    if (!fk.validated) {
      findings.push({
        code: 'FK_NOT_VALIDATED',
        severity: 'CRITICAL',
        relation: `${fk.childTable} -> ${fk.parentTable}`,
        count: 1,
        message: `Foreign Key ${fk.constraintName} ist nicht validiert.`,
      });
    }

    const orphanCount = await queryCount(client, orphanCountSql(fk));
    if (orphanCount > 0) {
      findings.push({
        code: 'FK_ORPHAN',
        severity: 'CRITICAL',
        relation: `${fk.childTable} -> ${fk.parentTable}`,
        count: orphanCount,
        message: `Foreign Key ${fk.constraintName} besitzt verwaiste Child-Zeilen.`,
      });
    }
  }

  const scopedTables = await client.$queryRawUnsafe<ScopedTableRow[]>(GAMESERVER_TABLES_SQL);
  const gameserverTables = scopedTables.filter((table) => table.tableName !== 'NitradoConnection');

  for (const table of gameserverTables) {
    const mismatchCount = await queryCount(client, gameserverMismatchSql(table));
    if (mismatchCount > 0) {
      findings.push({
        code: 'GAMESERVER_SCOPE_MISMATCH',
        severity: 'CRITICAL',
        relation: `${table.tableName} -> NitradoConnection`,
        count: mismatchCount,
        message: 'nitradoConnId und guildId zeigen nicht auf dieselbe NitradoConnection-Wahrheit.',
      });
    }
  }

  for (const check of SEMANTIC_CHECKS) {
    const count = await queryCount(client, check.sql);
    if (count > 0) {
      findings.push({
        code: check.code,
        severity: check.severity,
        relation: check.relation,
        count,
        message: check.message,
      });
    }
  }

  findings.sort((left, right) =>
    left.code.localeCompare(right.code) || left.relation.localeCompare(right.relation),
  );

  return {
    scannedAt: new Date().toISOString(),
    status: reportStatus(findings),
    scannedForeignKeys: foreignKeys.length,
    scannedGameserverTables: gameserverTables.length,
    findings,
  };
}
