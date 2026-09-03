import fs from 'node:fs';
import path from 'node:path';

test('market projection migration keeps messages uniquely separated by page or listing', () => {
  const sql = fs.readFileSync(path.resolve(__dirname, '../../prisma/migrations/20260831160000_market_inventoryless_discord_projection/migration.sql'), 'utf8');
  expect(sql).toContain('EconomyMarketDiscordMessage_shape_check');
  expect(sql).toContain('EconomyMarketDiscordMessage_projectionId_kind_pageIndex_key');
  expect(sql).toContain('EconomyMarketDiscordMessage_projectionId_kind_listingId_key');
  expect(sql).toContain('EconomyMarketDiscordProjection_direct_channel_required_check');
});

test('market message vendor-account repair migration matches the runtime model', () => {
  const sql = fs.readFileSync(path.resolve(__dirname, '../../prisma/migrations/20260903193000_fix_market_message_vendor_account/migration.sql'), 'utf8');
  expect(sql).toContain('ADD COLUMN IF NOT EXISTS "vendorAccountId" TEXT');
  expect(sql).toContain('EconomyMarketDiscordMessage_projectionId_kind_vendorAccountId_pageIndex_key');
  expect(sql).toContain('EconomyMarketDiscordMessage_vendor_idx');
});
