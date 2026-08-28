import fs from 'node:fs';
import { normalizeSourceNewlines } from '../helpers/sourceText';
import path from 'node:path';

const read = (relative: string): string => normalizeSourceNewlines(fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8'));

const service = read('src/modules/economy/virtualAccountMetadata.ts');
const configuration = read('src/modules/economy/virtualAccountConfiguration.ts');
const route = read('src/dashboard/routes/v2/economyVirtualAccountTreasurySafety.ts');
const controlRoute = read('src/dashboard/routes/v2/economyVirtualAccountControl.ts');
const discord = read('src/modules/economy/virtualAccountDiscord.ts');
const ui = read('dashboard-ui/src/components/economy/VirtualAccountsControlPanel.tsx');
const migration = read('prisma/migrations/20260819053000_economy_virtual_account_metadata/migration.sql');
const completionMigration = read('prisma/migrations/20260828214500_admin_force_link_virtual_archive_channel/migration.sql');
const db2 = read('prisma/migrations/20260817135600_db2_composite_scope_fks/migration.sql');

function compact(value: string): string { return value.replace(/\s+/g, ' '); }

describe('virtual account metadata architecture gate', () => {
  it('keeps metadata normalization and writes account, metadata, finance and managers atomically for configured creates', () => {
    expect(service).toContain('normalizeVirtualAccountDescription');
    expect(service).toContain('normalizeVirtualAccountChannels');
    expect(configuration).toContain("import { randomUUID } from 'node:crypto'");
    expect(configuration).toContain('const accountId = randomUUID()');
    expect(configuration).toContain('await prisma.$transaction(async tx =>');
    expect(configuration).toContain('INSERT INTO "EconomyVirtualAccount"');
    expect(configuration).toContain('INSERT INTO "EconomyVirtualAccountMetadata"');
    expect(configuration).toContain('INSERT INTO "EconomyVirtualAccountFinance"');
    expect(configuration).toContain('INSERT INTO "EconomyVirtualAccountManager"');
  });

  it('binds metadata to the exact Guild+Gameserver account at DB level', () => {
    expect(migration).toContain('EconomyVirtualAccountMetadata_account_scope_fkey');
    expect(compact(migration)).toContain('FOREIGN KEY ("accountId", "guildId", "nitradoConnId") REFERENCES "EconomyVirtualAccount"("id", "guildId", "nitradoConnId")');
    expect(db2).toContain('EconomyVirtualAccount_id_scope_key');
    expect(migration).toContain('ON DELETE CASCADE');
  });

  it('validates selected Discord channels against the active Guild before persistence', () => {
    expect(route).toContain('validateNormalTextChannel');
    expect(route).toContain('client.guilds.cache.get(guildId)');
    expect(route).toContain('channel.guildId !== guildId');
    expect(route).toContain('channel.type !== ChannelType.GuildText');
    expect(controlRoute).toContain('validateNormalTextChannel');
    expect(controlRoute).toContain('body.archiveChannelId');
  });

  it('requires a separate archive channel whenever Discord integration is enabled', () => {
    expect(service).toContain("if (!channelId && archiveChannelId)");
    expect(service).toContain("if (channelId && !archiveChannelId)");
    expect(service).toContain("if (channelId && archiveChannelId && channelId === archiveChannelId)");
    expect(completionMigration).toContain('ADD COLUMN IF NOT EXISTS "archiveChannelId" VARCHAR(20)');
    expect(completionMigration).toContain('EconomyVirtualAccountMetadata_channels_distinct');
    expect(compact(completionMigration)).toContain('CHECK ("channelId" IS NULL OR "archiveChannelId" IS NULL OR "channelId" <> "archiveChannelId")');
  });

  it('creates transaction threads only under the configured archive channel', () => {
    expect(discord).toContain('metadata.archiveChannelId');
    expect(discord).toContain('archiveChannel.threads.create');
    expect(discord).toContain('existingThread.parentId !== archiveChannel.id');
    expect(discord).not.toContain('channel.threads.create({');
  });

  it('uses shared guild channels and exposes live + archive channels in the dashboard', () => {
    expect(ui).toContain("queryKey: ['guild-channels', guildId]");
    expect(ui).toContain('`/api/v2/guilds/${guildId}/channels`');
    expect(ui).toContain('channel.type === 0');
    expect(ui).toContain('description: draft.description.trim() || null');
    expect(ui).toContain('channelId: draft.channelId || null');
    expect(ui).toContain('archiveChannelId: draft.archiveChannelId || null');
    expect(ui).toContain('maxLength={280}');
    expect(ui).toContain('Hauptkanal / Live-Embed');
    expect(ui).toContain('Archiv-Kanal / Transaktions-Threads');
    expect(ui).toContain('Hauptkanal und Archiv-Kanal müssen verschieden sein.');
  });
});
