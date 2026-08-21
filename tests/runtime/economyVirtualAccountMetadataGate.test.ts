import fs from 'node:fs';
import { normalizeSourceNewlines } from '../helpers/sourceText';
import path from 'node:path';

const read = (relative: string): string => normalizeSourceNewlines(fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8'));

const service = read('src/modules/economy/virtualAccountMetadata.ts');
const route = read('src/dashboard/routes/v2/economyVirtualAccounts.ts');
const ui = read('dashboard-ui/src/components/economy/VirtualAccountsPanel.tsx');
const migration = read('prisma/migrations/20260819053000_economy_virtual_account_metadata/migration.sql');
const db2 = read('prisma/migrations/20260817135600_db2_composite_scope_fks/migration.sql');

function compact(value: string): string { return value.replace(/\s+/g, ' '); }

describe('Economy-1J virtual account metadata architecture gate', () => {
  it('keeps CUSTOM account creation UUIDv4-backed and metadata in the same DB transaction', () => {
    expect(service).toContain("import { randomUUID } from 'node:crypto'");
    expect(service).toContain('const accountId = randomUUID()');
    expect(service).toContain('await prisma.$transaction(async tx =>');
    expect(service).toContain('INSERT INTO "EconomyVirtualAccount"');
    expect(service).toContain('INSERT INTO "EconomyVirtualAccountMetadata"');
  });

  it('binds metadata to the exact Guild+Gameserver account at DB level', () => {
    expect(migration).toContain('EconomyVirtualAccountMetadata_account_scope_fkey');
    expect(compact(migration)).toContain('FOREIGN KEY ("accountId", "guildId", "nitradoConnId") REFERENCES "EconomyVirtualAccount"("id", "guildId", "nitradoConnId")');
    expect(db2).toContain('EconomyVirtualAccount_id_scope_key');
    expect(migration).toContain('ON DELETE CASCADE');
  });

  it('validates a selected Discord channel against the active Guild before persistence', () => {
    expect(route).toContain('validateGuildTextChannel');
    expect(route).toContain('client.guilds.cache.get(guildId)');
    expect(route).toContain('channel.guildId !== guildId');
    expect(route).toContain('channel.type !== 0 && channel.type !== 5');
    expect(route.indexOf('validateGuildTextChannel')).toBeLessThan(route.indexOf('createCustomVirtualAccountWithMetadata({'));
  });

  it('uses the shared guild channel inventory and exposes description + channel in the dashboard', () => {
    expect(ui).toContain("queryKey: ['guild-channels', guildId]");
    expect(ui).toContain('`/api/v2/guilds/${guildId}/channels`');
    expect(ui).toContain('channel.type === 0 || channel.type === 5');
    expect(ui).toContain('description: description.trim() || null');
    expect(ui).toContain('channelId: channelId || null');
    expect(ui).toContain('maxLength={280}');
    expect(ui).toContain('— kein Channel —');
  });
});
