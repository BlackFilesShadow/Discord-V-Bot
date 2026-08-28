import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');
const migration = fs.readFileSync(path.join(ROOT, 'prisma/migrations/20260828214500_admin_force_link_virtual_archive_channel/migration.sql'), 'utf8');

describe('virtual-account archive channel migration gate', () => {
  it('keeps archive channel optional for legacy rows but distinct when configured', () => {
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS "archiveChannelId" VARCHAR(20)');
    expect(migration).toContain('"archiveChannelId" IS NULL OR "archiveChannelId" ~');
    expect(migration).toContain('"channelId" IS NULL OR "archiveChannelId" IS NULL OR "channelId" <> "archiveChannelId"');
    expect(migration).toContain('EconomyVirtualAccountMetadata_archive_channel_idx');
  });
});
