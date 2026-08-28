import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');
const migration = fs.readFileSync(path.join(ROOT, 'prisma/migrations/20260828214500_admin_force_link_virtual_archive_channel/migration.sql'), 'utf8');

describe('admin force-link migration gate', () => {
  it('keeps provisional player names printable, nullable and server-scoped unique only while verified', () => {
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS "forcedPlayerName" VARCHAR(64)');
    expect(migration).toContain('char_length(btrim("forcedPlayerName")) BETWEEN 1 AND 64');
    expect(migration).toContain("ON \"GameIdentityLink\"(\"guildId\", \"nitradoConnId\", \"forcedPlayerName\")");
    expect(migration).toContain("WHERE \"status\"='VERIFIED' AND \"forcedPlayerName\" IS NOT NULL");
  });
});
