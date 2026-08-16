import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');
const schema = fs.readFileSync(path.join(ROOT, 'prisma/schema.prisma'), 'utf8');
const migration = fs.readFileSync(path.join(ROOT, 'prisma/migrations/20260816133000_economy_lottery/migration.sql'), 'utf8');

describe('lottery migration/schema parity', () => {
  it('haelt Status- und Economy-Tx-Enums deckungsgleich', () => {
    for (const value of ['ACTIVE', 'DRAWING', 'REFUNDING', 'FINISHED', 'REFUNDED']) {
      expect(schema).toContain(value);
      expect(migration).toContain(value);
    }
    for (const value of ['LOTTERY_TICKET', 'LOTTERY_PAYOUT', 'LOTTERY_REFUND']) {
      expect(schema).toContain(value);
      expect(migration).toContain(value);
    }
  });

  it('haelt alle kanonischen Indexnamen synchron', () => {
    for (const name of [
      'LotteryRound_activeScopeKey_key',
      'LotteryRound_scope_status_ends_idx',
      'LotteryRound_scope_created_idx',
      'LotteryEntry_round_user_key',
      'LotteryEntry_scope_user_idx',
      'LotteryEntry_round_refund_idx',
      'LotteryPurchase_idempotencyKey_key',
      'LotteryPurchase_round_user_created_idx',
    ]) {
      expect(schema).toContain(name);
      expect(migration).toContain(name);
    }
  });

  it('haelt alle Lottery-FKs restriktiv', () => {
    expect(schema).toContain('potAccount            EconomyVirtualAccount @relation(fields: [potAccountId], references: [id], onDelete: Restrict)');
    expect(schema.match(/LotteryRound @relation\(fields: \[roundId\], references: \[id\], onDelete: Restrict\)/g)?.length ?? 0).toBe(2);
    expect(migration.match(/ON DELETE RESTRICT/g)?.length ?? 0).toBe(3);
  });
});