import fs from 'node:fs';
import path from 'node:path';

const migrationPath = path.resolve(
  __dirname,
  '../../prisma/migrations/20260826204500_nitrado_slot_delete_scope_cleanup/migration.sql',
);
const migration = fs.readFileSync(migrationPath, 'utf8');

describe('Nitrado slot deletion database invariant', () => {
  it('discovers nitradoConnId tables dynamically instead of maintaining a fragile hard-coded cleanup list', () => {
    expect(migration).toContain("information_schema.columns");
    expect(migration).toContain("c.column_name IN ('nitradoConnId', 'guildId')");
    expect(migration).toContain("HAVING bool_or(c.column_name = 'nitradoConnId')");
    expect(migration).toContain("LOCK TABLE %I.%I IN SHARE ROW EXCLUSIVE MODE");
    expect(migration).toContain('NITRADO_SLOT_DELETE_SCOPE_BLOCKED');
  });

  it('removes a RESOLVED economy binding with the deleted connection and enforces the relation physically', () => {
    expect(migration).toContain('EconomyScopeMigration_primary_nitrado_scope_fkey');
    expect(migration).toContain('FOREIGN KEY ("primaryNitradoConnId", "guildId")');
    expect(migration).toContain('REFERENCES "NitradoConnection"("id", "guildId")');
    expect(migration).toContain('ON DELETE CASCADE');
    expect(migration).toContain('"primaryNitradoConnId" = OLD."id"');
  });

  it('installs the cleanup as a BEFORE DELETE trigger on NitradoConnection', () => {
    expect(migration).toContain('CREATE TRIGGER "trg_nitrado_connection_scope_cleanup"');
    expect(migration).toContain('BEFORE DELETE ON "NitradoConnection"');
    expect(migration).toContain('vbot_cleanup_nitrado_connection_scope_before_delete');
  });
});
