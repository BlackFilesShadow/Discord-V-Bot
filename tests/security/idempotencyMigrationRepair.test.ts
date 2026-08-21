import fs from 'fs';
import path from 'path';
import { Client } from 'pg';

import { describeDb } from '../helpers/dbIntegration';

const databaseUrl = process.env.DATABASE_URL;

describeDb('F-004/F-009 — legacy IdempotencyKey baseline repair', () => {
  let client: Client;
  const schema = `idem_repair_${process.pid}_${Date.now()}`;
  const quotedSchema = `"${schema.replace(/"/g, '""')}"`;
  const migrationSql = fs.readFileSync(
    path.join(process.cwd(), 'prisma/migrations/20260814000000_repair_idempotency_baseline_drift/migration.sql'),
    'utf8',
  );

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query(`CREATE SCHEMA ${quotedSchema}`);
    await client.query(`SET search_path TO ${quotedSchema}`);
    await client.query(`
      CREATE TABLE "IdempotencyKey" (
        "hash" TEXT NOT NULL,
        "responseBody" JSONB NOT NULL,
        "responseStatus" INTEGER NOT NULL,
        "createdAt" TIMESTAMP(3) WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "expiresAt" TIMESTAMP(3) WITHOUT TIME ZONE NOT NULL,
        CONSTRAINT "IdempotencyKey_pkey" PRIMARY KEY ("hash")
      );
      CREATE INDEX "IdempotencyKey_expiresAt_idx" ON "IdempotencyKey"("expiresAt");
      INSERT INTO "IdempotencyKey" ("hash", "responseBody", "responseStatus", "expiresAt")
      SELECT 'legacy-' || n::text, jsonb_build_object('n', n), 200,
             CURRENT_TIMESTAMP + INTERVAL '1 hour'
      FROM generate_series(1, 1118) AS n;
    `);
  });

  afterAll(async () => {
    if (!client) return;
    await client.query('SET search_path TO public');
    await client.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
    await client.end();
  });

  it('repairs the legacy shape without losing completed rows', async () => {
    const before = await client.query<{ count: number }>('SELECT COUNT(*)::int AS count FROM "IdempotencyKey"');
    expect(before.rows[0].count).toBe(1118);

    await client.query(migrationSql);

    const after = await client.query<{ count: number; done_count: number }>(`
      SELECT COUNT(*)::int AS count,
             COUNT(*) FILTER (WHERE "status" = 'DONE')::int AS done_count
      FROM "IdempotencyKey"
    `);
    expect(after.rows[0]).toEqual({ count: 1118, done_count: 1118 });

    const columns = await client.query<{ column_name: string; is_nullable: 'YES' | 'NO' }>(`
      SELECT column_name, is_nullable
      FROM information_schema.columns
      WHERE table_schema = $1
        AND table_name = 'IdempotencyKey'
        AND column_name IN ('status', 'responseBody', 'responseStatus')
      ORDER BY column_name
    `, [schema]);
    expect(columns.rows).toEqual([
      { column_name: 'responseBody', is_nullable: 'YES' },
      { column_name: 'responseStatus', is_nullable: 'YES' },
      { column_name: 'status', is_nullable: 'NO' },
    ]);
  });

  it('is idempotent and permits PROCESSING without response data', async () => {
    await client.query(`
      INSERT INTO "IdempotencyKey" ("hash", "status", "expiresAt")
      VALUES ('new-processing', 'PROCESSING', CURRENT_TIMESTAMP + INTERVAL '1 hour')
    `);
    await client.query(migrationSql);

    const row = await client.query<{ status: string; responseBody: unknown | null; responseStatus: number | null }>(`
      SELECT "status", "responseBody", "responseStatus"
      FROM "IdempotencyKey"
      WHERE "hash" = 'new-processing'
    `);
    expect(row.rows[0]).toEqual({ status: 'PROCESSING', responseBody: null, responseStatus: null });
  });
});
