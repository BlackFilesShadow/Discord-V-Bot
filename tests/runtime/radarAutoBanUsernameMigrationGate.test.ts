import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');
const read = (relativePath: string): string => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

describe('Radar auto-ban username migration gate', () => {
  it('adds the optional subject identity without rewriting existing remote secrets', () => {
    const migration = read('prisma/migrations/20260919153000_radar_autoban_remote_username/migration.sql');
    expect(migration).toContain('ALTER TABLE "ServerBanRemoteIdentity"');
    expect(migration).toContain('ADD COLUMN "subjectIdentifierEnc" TEXT');
    expect(migration).not.toMatch(/UPDATE\s+"ServerBanRemoteIdentity"/i);
  });
});
