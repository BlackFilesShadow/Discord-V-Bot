import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('Economy-Lotterie — Production-Sicherheitsinvarianten', () => {
  const migration = read('prisma/migrations/20260816133000_economy_lottery/migration.sql');
  const schema = read('prisma/schema.prisma');
  const lottery = read('src/modules/economy/lottery.ts');
  const transfers = read('src/modules/economy/systemVirtualTransfers.ts');

  it('erzwingt servergescoppte Round-, Entry- und Purchase-Daten', () => {
    for (const model of ['LotteryRound', 'LotteryEntry', 'LotteryPurchase']) {
      const start = schema.indexOf(`model ${model} {`);
      expect(start).toBeGreaterThan(-1);
      const end = schema.indexOf('\n}', start);
      const block = schema.slice(start, end);
      expect(block).toContain('guildId');
      expect(block).toContain('nitradoConnId');
    }
    expect(migration).toContain('"guildId" TEXT NOT NULL');
    expect(migration).toContain('"nitradoConnId" TEXT NOT NULL');
  });

  it('erlaubt konstruktiv nur eine nicht abgeschlossene Runde pro Guild+Gameserver', () => {
    expect(schema).toContain('activeScopeKey        String?            @unique(map: "LotteryRound_activeScopeKey_key")');
    expect(migration).toContain('CREATE UNIQUE INDEX "LotteryRound_activeScopeKey_key"');
    expect(lottery).toContain('activeScopeKey: scopeKey(args.guildId, args.nitradoConnId)');
    expect(lottery).toContain('"activeScopeKey"=NULL');
  });

  it('nutzt ausschliesslich LOTTERY_POT aus der gemeinsamen VirtualAccount-Infrastruktur', () => {
    expect(lottery).toContain("kind: 'LOTTERY_POT'");
    expect(lottery).toContain("expectedKind: 'LOTTERY_POT'");
    expect(lottery).toContain('systemUserToVirtualAccount');
    expect(lottery).toContain('systemVirtualAccountToUser');
    expect(lottery).not.toContain('EconomyLottery');
    expect(migration).toContain('REFERENCES "EconomyVirtualAccount"("id")');
  });

  it('zieht den Gewinner kryptographisch sicher nur beim ACTIVE->DRAWING-Uebergang', () => {
    expect(lottery).toContain("import { randomInt, randomUUID } from 'node:crypto';");
    expect(lottery).toContain("if (round.status !== 'ACTIVE' || round.endsAt.getTime() > Date.now()) return round.status;");
    expect(lottery).toContain('const drawIndex = randomInt(totalTickets);');
    expect(lottery).toContain(String.raw`\"status\"=\'DRAWING\'::\"LotteryRoundStatus\"`);
    expect(lottery).toContain('"winnerDiscordId"=$2');
    expect(lottery).toContain('"winningTicketNumber"=$3');
  });

  it('vergleicht Ticket-/Teilnehmer-/Pot-Invarianten vor jeder Ziehung oder Refund-Transition', () => {
    expect(lottery).toContain('totalTickets !== round.totalTickets');
    expect(lottery).toContain('entries.length !== round.participantCount');
    expect(lottery).toContain('pot.balance !== totalPaid');
    expect(lottery).toContain('Lotterie-Invariante verletzt');
  });

  it('macht Auszahlung und Refunds deterministisch idempotent und restart-fest', () => {
    expect(lottery).toContain('idempotencyKey: `lottery-payout:${round.id}`');
    expect(lottery).toContain('idempotencyKey: `lottery-refund:${round.id}:${entry.userDiscordId}`');
    expect(lottery).toContain("{ status: { in: ['DRAWING', 'REFUNDING'] } }");
    expect(lottery).toContain('refundedAt: null');
    expect(lottery).toContain("status: 'REFUNDING'");
    expect(lottery).toContain("status: 'REFUNDED'");
  });

  it('behandelt parallele identische Ticketkaeufe als Replay statt als neues Limit-Ereignis', () => {
    expect(lottery).toContain('const replayPurchases = await raw.$queryRawUnsafe');
    expect(lottery).toContain("WHERE \"idempotencyKey\"=$1 LIMIT 1");
    expect(lottery).toContain('return { firstPurchase: false, replay: true };');
  });

  it('finalisiert Refunds nur bei wirklich leerem Pot und verhindert lokalen Scheduler-Overlap', () => {
    expect(lottery).toContain("if (terminal.potBalance !== 0n) throw new Error('Refund-Runde kann mit Restguthaben im Pot nicht finalisiert werden.')");
    expect(lottery).toContain('if (lotterySchedulerBusy) return;');
    expect(lottery).toContain('finally {');
    expect(lottery).toContain('lotterySchedulerBusy = false;');
  });

  it('archiviert Auditdaten nie per Cascade/Delete', () => {
    expect(migration).not.toContain('ON DELETE CASCADE');
    expect(migration.match(/ON DELETE RESTRICT/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });

  it('haertet generische Systemtransfers gegen Replay-Payload-Mismatch und Steuerzeichen', () => {
    expect(transfers).toContain('System-Idempotency-Key wurde mit anderen Buchungsdaten wiederverwendet.');
    const cleanStart = transfers.indexOf('function cleanText');
    const cleanEnd = transfers.indexOf('function operationKey', cleanStart);
    const clean = transfers.slice(cleanStart, cleanEnd);
    expect(clean.indexOf('/[\\r\\n\\t\\u0000-\\u001f\\u007f]/')).toBeLessThan(clean.indexOf('.trim().replace'));
  });

  it('priorisiert geldkritische Settlement-Runden vor Ergebnis-Ankuendigungen und verhindert Scheduler-Starvation', () => {
    expect(lottery).toContain('const settlementRounds = await prisma.lotteryRound.findMany');
    expect(lottery).toContain('const announcementRounds = await prisma.lotteryRound.findMany');
    const settlementStart = lottery.indexOf('const settlementRounds');
    const announcementStart = lottery.indexOf('const announcementRounds');
    expect(settlementStart).toBeGreaterThan(-1);
    expect(announcementStart).toBeGreaterThan(settlementStart);
    const settlementBlock = lottery.slice(settlementStart, announcementStart);
    expect(settlementBlock).toContain("{ status: { in: ['DRAWING', 'REFUNDING'] } }");
    expect(settlementBlock).not.toContain("['FINISHED', 'REFUNDED']");
  });

  it('verhindert endlose REFUNDED-Scheduler-Wiederholung durch announcedAt', () => {
    expect(lottery).toContain("if (round.status === 'REFUNDED')");
    expect(lottery).toContain("where: { id: round.id, status: 'REFUNDED', announcedAt: null }");
    expect(lottery).toContain('data: { announcedAt: new Date() }');
  });
});