# Idempotency baseline repair

## Incident

A production database adopted the consolidated Prisma baseline while still carrying the pre-F-004 `IdempotencyKey` table shape. Because `prisma migrate resolve --applied 00000000000000_baseline` records the baseline without executing its SQL, a legacy schema can be reported as migration-current while still missing baseline changes.

Confirmed production state before repair:

- `IdempotencyStatus` did not exist.
- `IdempotencyKey.status` did not exist.
- `IdempotencyKey.responseBody` was `NOT NULL`.
- `IdempotencyKey.responseStatus` was `NOT NULL`.
- 1118 existing idempotency rows were present and must be preserved.

## Repair

Migration `20260814000000_repair_idempotency_baseline_drift` restores the schema expected by the current atomic idempotency middleware:

- create `IdempotencyStatus` (`PROCESSING`, `DONE`) if absent;
- add `IdempotencyKey.status` with `NOT NULL DEFAULT 'DONE'` if absent;
- make `responseBody` nullable;
- make `responseStatus` nullable.

Existing legacy rows therefore remain completed records (`DONE`) and keep their stored response data. New `PROCESSING` claims may exist before response data is available.

## Automated verification

`tests/security/idempotencyMigrationRepair.test.ts` recreates the confirmed legacy table shape in an isolated PostgreSQL schema, inserts 1118 rows, applies the repair and verifies:

1. the row count remains 1118;
2. all legacy rows receive `DONE`;
3. `status` is non-null;
4. `responseBody` and `responseStatus` are nullable;
5. a new `PROCESSING` row can be inserted without response data;
6. applying the migration again does not destroy that active claim.

The normal CI database is independently built by `prisma migrate deploy`, which also verifies that the repair migration is safe on an already-current baseline database.

## Production rollout gate

Before deploying the repair, take a PostgreSQL backup. Do not use `prisma db push` for this repair.

After deployment, verify the production schema and data before marking the incident closed:

```sql
SELECT COUNT(*) FROM "IdempotencyKey";

SELECT typname
FROM pg_type
WHERE typname = 'IdempotencyStatus';

SELECT column_name, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'IdempotencyKey'
  AND column_name IN ('status', 'responseBody', 'responseStatus')
ORDER BY column_name;

SELECT "status", COUNT(*)
FROM "IdempotencyKey"
GROUP BY "status"
ORDER BY "status";
```

Expected immediately after repair of the confirmed production state:

- total row count remains 1118 (unless legitimate application traffic added rows during rollout);
- `IdempotencyStatus` exists;
- `status` is non-null with default `DONE`;
- `responseBody` and `responseStatus` are nullable;
- the pre-existing 1118 rows are `DONE`.

Finally verify application logs contain no new `IdempotencyKey.status does not exist` errors during an idempotency-protected dashboard mutation.

## Follow-up

This migration fixes the confirmed F-004/F-009 production drift. It does not prove that no other table was affected by the historical baseline adoption. A full production-schema-versus-current-Prisma drift audit remains a separate P0 follow-up before the baseline-adoption mechanism is considered fully closed.
