import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('Economy Serverbank-Zinsen — Sicherheitsgate', () => {
  const treasuryInterest = read('src/modules/economy/virtualAccountInterest.ts');
  const cron = read('src/modules/economy/interestCron.ts');

  it('verzinst ausschliesslich BANK_TREASURY und keine Markt-/Lotterie-/GENERAL-Konten', () => {
    expect(treasuryInterest).toContain("f.\"accountPurpose\"='BANK_TREASURY'");
    expect(treasuryInterest).toContain("a.\"kind\"='CUSTOM'::\"EconomyVirtualAccountKind\"");
    expect(treasuryInterest).toContain("a.\"status\"='ACTIVE'::\"EconomyVirtualAccountStatus\"");
    expect(treasuryInterest).not.toContain("accountPurpose='GENERAL'");
    expect(treasuryInterest).not.toContain("kind='MARKET_VENDOR'");
    expect(treasuryInterest).not.toContain("kind='LOTTERY_POT'");
  });

  it('lockt die Bankzeile und bucht pro Server, Tag und Konto idempotent', () => {
    expect(treasuryInterest).toContain('FOR UPDATE OF f, a');
    expect(treasuryInterest).toContain('interest:treasury:${args.guildId}:${args.nitradoConnId}:${args.runDate}:${row.accountId}');
    expect(treasuryInterest).toContain('ON CONFLICT ("idempotencyKey") DO NOTHING');
    expect(treasuryInterest).toContain('"bankBalance"="bankBalance"+$4');
    expect(treasuryInterest).toContain("'BANK_INTEREST'");
    expect(treasuryInterest).toContain("'BANK'");
  });

  it('verwendet denselben serverbezogenen Basispunkt-Satz wie Spielerbanken', () => {
    expect(cron).toContain('getInterestBasisPoints(c.guildId, c.nitradoConnId)');
    expect(cron).toContain('runDailyInterestForServer');
    expect(cron).toContain('runDailyTreasuryInterestForServer');
    expect(cron).toContain('basisPoints');
  });
});