import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');
const schema = fs.readFileSync(path.join(ROOT, 'prisma/schema.prisma'), 'utf8');
const migration = fs.readFileSync(path.join(ROOT, 'prisma/migrations/20260816124500_economy_virtual_accounts/migration.sql'), 'utf8');

describe('virtual account migration parity', () => {
  it('haelt die kanonischen Indexnamen in Schema und Migration synchron', () => {
    for (const name of [
      'EconomyVirtualAccount_guild_conn_name_key',
      'EconomyVirtualAccount_guild_conn_status_idx',
      'EconomyVirtualAccount_expiry_idx',
      'EconomyVirtualAccount_kind_idx',
      'EconomyVirtualAccountEntry_account_created_idx',
      'EconomyVirtualAccountEntry_user_created_idx',
    ]) {
      expect(schema).toContain(name);
      expect(migration).toContain(name);
    }
  });

  it('haelt Kontotypen und Statuswerte deckungsgleich', () => {
    for (const value of ['CUSTOM', 'LOTTERY_POT', 'MARKET_VENDOR', 'ACTIVE', 'EXPIRED', 'ARCHIVED']) {
      expect(schema).toContain(value);
      expect(migration).toContain(value);
    }
  });
});
