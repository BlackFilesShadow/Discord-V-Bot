import fs from 'node:fs';
import path from 'node:path';

test('multiple virtual accounts may share channels while retaining account-owned messages and archive threads', () => {
  const migration = fs.readFileSync(path.resolve(__dirname, '../../prisma/migrations/20260826190000_virtual_account_wallet_bank_currency_projection/migration.sql'), 'utf8');
  const discord = fs.readFileSync(path.resolve(__dirname, '../../src/modules/economy/virtualAccountDiscord.ts'), 'utf8');
  expect(migration).toContain('CONSTRAINT "EconomyVirtualAccountProjection_pkey" PRIMARY KEY ("accountId")');
  expect(migration).not.toContain('UNIQUE ("channelId")');
  expect(migration).toContain('EconomyVirtualAccountProjection_archive_thread_key');
  expect(discord).toContain('archiveChannel.threads.create');
  expect(discord).toContain('existingThread.parentId !== archiveChannel.id');
});
