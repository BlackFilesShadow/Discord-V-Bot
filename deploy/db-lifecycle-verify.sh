#!/usr/bin/env bash
set -euo pipefail

# DB-4 production lifecycle verification.
# Verifies fresh migrations, a real upgrade path from the pre-DB-2 release,
# and pg_dump/pg_restore integrity on isolated throw-away databases.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UPGRADE_FROM="${DB_LIFECYCLE_UPGRADE_FROM:-20260817135600_db2_composite_scope_fks}"
BASE_URL="${DATABASE_URL:?DATABASE_URL is required}"
RUN_ID="${GITHUB_RUN_ID:-local}"
SUFFIX="${RUN_ID//[^A-Za-z0-9]/}_$$_${RANDOM}"
FRESH_DB="vbot_db4_fresh_${SUFFIX}"
UPGRADE_DB="vbot_db4_upgrade_${SUFFIX}"
RESTORE_DB="vbot_db4_restore_${SUFFIX}"
TMP_ROOT="$(mktemp -d)"
DUMP_FILE="$TMP_ROOT/upgrade.dump"

for cmd in node npx npm psql pg_dump pg_restore; do
  command -v "$cmd" >/dev/null 2>&1 || {
    echo "[DB-4] required command missing: $cmd" >&2
    exit 2
  }
done

DB_HOST="$(node -e 'const u=new URL(process.env.DATABASE_URL); process.stdout.write(u.hostname)')"
DB_PORT="$(node -e 'const u=new URL(process.env.DATABASE_URL); process.stdout.write(u.port || "5432")')"
DB_USER="$(node -e 'const u=new URL(process.env.DATABASE_URL); process.stdout.write(decodeURIComponent(u.username))')"
DB_PASS="$(node -e 'const u=new URL(process.env.DATABASE_URL); process.stdout.write(decodeURIComponent(u.password))')"
export PGPASSWORD="$DB_PASS"

make_url() {
  DB4_TARGET_DB="$1" DATABASE_URL="$BASE_URL" node -e '
    const u = new URL(process.env.DATABASE_URL);
    u.pathname = `/${process.env.DB4_TARGET_DB}`;
    process.stdout.write(u.toString());
  '
}

admin_psql() {
  psql -X -v ON_ERROR_STOP=1 -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d postgres "$@"
}

db_psql() {
  local db="$1"; shift
  psql -X -v ON_ERROR_STOP=1 -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$db" "$@"
}

create_db() {
  local db="$1"
  admin_psql -qAtc "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$db' AND pid <> pg_backend_pid();" >/dev/null
  admin_psql -qAtc "DROP DATABASE IF EXISTS \"$db\";" >/dev/null
  admin_psql -qAtc "CREATE DATABASE \"$db\";" >/dev/null
}

drop_db() {
  local db="$1"
  admin_psql -qAtc "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$db' AND pid <> pg_backend_pid();" >/dev/null 2>&1 || true
  admin_psql -qAtc "DROP DATABASE IF EXISTS \"$db\";" >/dev/null 2>&1 || true
}

cleanup() {
  drop_db "$RESTORE_DB"
  drop_db "$UPGRADE_DB"
  drop_db "$FRESH_DB"
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

migration_count() {
  local db="$1"
  db_psql "$db" -qAtc 'SELECT COUNT(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;'
}

schema_signature() {
  local db="$1"
  db_psql "$db" -qAtc "
    SELECT concat(
      (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'), ':',
      (SELECT COUNT(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public' AND c.contype='f'), ':',
      (SELECT COUNT(*) FROM pg_indexes WHERE schemaname='public')
    );
  "
}

run_consistency() {
  local url="$1"
  (cd "$REPO_ROOT" && DATABASE_URL="$url" npm run db:consistency)
}

printf '[DB-4] Fresh DB verification...\n'
create_db "$FRESH_DB"
FRESH_URL="$(make_url "$FRESH_DB")"
(
  cd "$REPO_ROOT"
  DATABASE_URL="$FRESH_URL" npx prisma migrate deploy
  DATABASE_URL="$FRESH_URL" npx prisma migrate status
)
run_consistency "$FRESH_URL"
FRESH_MIGRATIONS="$(migration_count "$FRESH_DB")"
[[ "$FRESH_MIGRATIONS" =~ ^[1-9][0-9]*$ ]] || {
  echo "[DB-4] fresh DB has no completed Prisma migrations" >&2
  exit 3
}

printf '[DB-4] Upgrade DB verification from %s...\n' "$UPGRADE_FROM"
[[ -d "$REPO_ROOT/prisma/migrations/$UPGRADE_FROM" ]] || {
  echo "[DB-4] upgrade cutoff migration missing: $UPGRADE_FROM" >&2
  exit 4
}
create_db "$UPGRADE_DB"
UPGRADE_URL="$(make_url "$UPGRADE_DB")"
mkdir -p "$TMP_ROOT/upgrade"
cp -R "$REPO_ROOT/prisma" "$TMP_ROOT/upgrade/prisma"
ln -s "$REPO_ROOT/node_modules" "$TMP_ROOT/upgrade/node_modules"
cat > "$TMP_ROOT/upgrade/prisma.config.ts" <<'EOF'
import { defineConfig } from '@prisma/config';
export default defineConfig({
  schema: './prisma',
  datasource: { url: process.env.DATABASE_URL! },
  migrations: { path: './prisma/migrations' },
});
EOF

for migration_dir in "$TMP_ROOT/upgrade/prisma/migrations"/*; do
  [[ -d "$migration_dir" ]] || continue
  migration_name="$(basename "$migration_dir")"
  if [[ "$migration_name" == "$UPGRADE_FROM" || "$migration_name" > "$UPGRADE_FROM" ]]; then
    rm -rf "$migration_dir"
  fi
done

(
  cd "$TMP_ROOT/upgrade"
  DATABASE_URL="$UPGRADE_URL" "$REPO_ROOT/node_modules/.bin/prisma" migrate deploy --config "$TMP_ROOT/upgrade/prisma.config.ts"
)
OLD_MIGRATIONS="$(migration_count "$UPGRADE_DB")"
if ! [[ "$OLD_MIGRATIONS" =~ ^[1-9][0-9]*$ ]] || (( OLD_MIGRATIONS >= FRESH_MIGRATIONS )); then
  echo "[DB-4] invalid upgrade baseline: old=$OLD_MIGRATIONS current=$FRESH_MIGRATIONS" >&2
  exit 5
fi

# A migration-survival sentinel is intentionally not part of the application
# schema. It proves that an upgrade does not silently replace/recreate the DB.
db_psql "$UPGRADE_DB" -q <<'SQL'
CREATE TABLE "_DbLifecycleSentinel" (
  id text PRIMARY KEY,
  payload text NOT NULL
);
INSERT INTO "_DbLifecycleSentinel" (id, payload)
VALUES ('db4-upgrade-sentinel', 'preserve-me');
SQL

rm -rf "$TMP_ROOT/upgrade/prisma/migrations"
cp -R "$REPO_ROOT/prisma/migrations" "$TMP_ROOT/upgrade/prisma/migrations"
(
  cd "$TMP_ROOT/upgrade"
  DATABASE_URL="$UPGRADE_URL" "$REPO_ROOT/node_modules/.bin/prisma" migrate deploy --config "$TMP_ROOT/upgrade/prisma.config.ts"
  DATABASE_URL="$UPGRADE_URL" "$REPO_ROOT/node_modules/.bin/prisma" migrate status --config "$TMP_ROOT/upgrade/prisma.config.ts"
)
run_consistency "$UPGRADE_URL"
UPGRADE_MIGRATIONS="$(migration_count "$UPGRADE_DB")"
[[ "$UPGRADE_MIGRATIONS" == "$FRESH_MIGRATIONS" ]] || {
  echo "[DB-4] upgrade migration count differs from fresh DB: upgrade=$UPGRADE_MIGRATIONS fresh=$FRESH_MIGRATIONS" >&2
  exit 6
}
SENTINEL="$(db_psql "$UPGRADE_DB" -qAtc "SELECT payload FROM \"_DbLifecycleSentinel\" WHERE id='db4-upgrade-sentinel';")"
[[ "$SENTINEL" == "preserve-me" ]] || {
  echo "[DB-4] upgrade sentinel was lost or modified" >&2
  exit 7
}

printf '[DB-4] Backup/restore verification...\n'
pg_dump --format=custom --no-owner --no-privileges \
  -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$UPGRADE_DB" \
  -f "$DUMP_FILE"
[[ -s "$DUMP_FILE" ]] || {
  echo "[DB-4] pg_dump produced an empty file" >&2
  exit 8
}
create_db "$RESTORE_DB"
pg_restore --exit-on-error --no-owner --no-privileges \
  -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$RESTORE_DB" \
  "$DUMP_FILE"
RESTORE_URL="$(make_url "$RESTORE_DB")"
(
  cd "$REPO_ROOT"
  DATABASE_URL="$RESTORE_URL" npx prisma migrate status
)
run_consistency "$RESTORE_URL"
RESTORE_MIGRATIONS="$(migration_count "$RESTORE_DB")"
[[ "$RESTORE_MIGRATIONS" == "$UPGRADE_MIGRATIONS" ]] || {
  echo "[DB-4] restored migration history differs: restore=$RESTORE_MIGRATIONS source=$UPGRADE_MIGRATIONS" >&2
  exit 9
}
RESTORED_SENTINEL="$(db_psql "$RESTORE_DB" -qAtc "SELECT payload FROM \"_DbLifecycleSentinel\" WHERE id='db4-upgrade-sentinel';")"
[[ "$RESTORED_SENTINEL" == "preserve-me" ]] || {
  echo "[DB-4] backup/restore lost the sentinel row" >&2
  exit 10
}

UPGRADE_SIGNATURE="$(schema_signature "$UPGRADE_DB")"
RESTORE_SIGNATURE="$(schema_signature "$RESTORE_DB")"
[[ "$RESTORE_SIGNATURE" == "$UPGRADE_SIGNATURE" ]] || {
  echo "[DB-4] restored schema signature differs: restore=$RESTORE_SIGNATURE source=$UPGRADE_SIGNATURE" >&2
  exit 11
}

printf '[DB-4] PASS fresh=%s migrations, upgrade=%s, schema=%s\n' \
  "$FRESH_MIGRATIONS" "$UPGRADE_MIGRATIONS" "$RESTORE_SIGNATURE"
