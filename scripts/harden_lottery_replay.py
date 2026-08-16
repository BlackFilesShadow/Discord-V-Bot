from pathlib import Path

p = Path('src/modules/economy/lottery.ts')
text = p.read_text(encoding='utf-8')

old = '''      const round = rounds[0];
      if (!round) throw new Error('Lotterie nicht gefunden.');
      if (round.status !== 'ACTIVE' || round.endsAt.getTime() <= Date.now()) throw new Error('Lotterie ist bereits geschlossen.');
'''
new = '''      const round = rounds[0];
      if (!round) throw new Error('Lotterie nicht gefunden.');
      const purchaseReplay = await raw.$queryRawUnsafe<Array<{ userDiscordId: string; ticketCount: number; roundId: string }>>(
        'SELECT "userDiscordId", "ticketCount", "roundId" FROM "LotteryPurchase" WHERE "idempotencyKey"=$1 LIMIT 1',
        key,
      );
      if (purchaseReplay[0]) {
        if (purchaseReplay[0].userDiscordId !== String(args.userDiscordId) || purchaseReplay[0].ticketCount !== args.quantity || purchaseReplay[0].roundId !== args.roundId) {
          throw new Error('Kauf-Idempotency-Key wurde mit anderen Daten wiederverwendet.');
        }
        return { firstPurchase: false };
      }
      if (round.status !== 'ACTIVE' || round.endsAt.getTime() <= Date.now()) throw new Error('Lotterie ist bereits geschlossen.');
'''
if old not in text:
    raise SystemExit('ticket preflight marker missing')
text = text.replace(old, new, 1)

old = '''  const remaining = await prisma.lotteryEntry.count({ where: { roundId: round.id, refundedAt: null } });
  if (remaining > 0) return false;
  const changed = await prisma.lotteryRound.updateMany({
'''
new = '''  const remaining = await prisma.lotteryEntry.count({ where: { roundId: round.id, refundedAt: null } });
  if (remaining > 0) return false;
  const terminal = await fetchRoundViewById(round.id);
  if (!terminal) throw new Error('Refund-Runde ist beim Finalisieren verschwunden.');
  if (terminal.potBalance !== 0n) throw new Error('Refund-Runde kann mit Restguthaben im Pot nicht finalisiert werden.');
  const changed = await prisma.lotteryRound.updateMany({
'''
if old not in text:
    raise SystemExit('refund finalization marker missing')
text = text.replace(old, new, 1)

old = '''let lotterySchedulerTimer: NodeJS.Timeout | null = null;
const LOTTERY_INTERVAL_MS = 5_000;
'''
new = '''let lotterySchedulerTimer: NodeJS.Timeout | null = null;
let lotterySchedulerBusy = false;
const LOTTERY_INTERVAL_MS = 5_000;
'''
if old not in text:
    raise SystemExit('scheduler state marker missing')
text = text.replace(old, new, 1)

old = '''  lotterySchedulerTimer = setInterval(async () => {
    try {
      const guildIds = [...client.guilds.cache.keys()];
'''
new = '''  lotterySchedulerTimer = setInterval(async () => {
    if (lotterySchedulerBusy) return;
    lotterySchedulerBusy = true;
    try {
      const guildIds = [...client.guilds.cache.keys()];
'''
if old not in text:
    raise SystemExit('scheduler start marker missing')
text = text.replace(old, new, 1)

old = '''    } catch (error) {
      logger.error('Lotterie-Scheduler Fehler:', error as Error);
    }
  }, LOTTERY_INTERVAL_MS);
'''
new = '''    } catch (error) {
      logger.error('Lotterie-Scheduler Fehler:', error as Error);
    } finally {
      lotterySchedulerBusy = false;
    }
  }, LOTTERY_INTERVAL_MS);
'''
if old not in text:
    raise SystemExit('scheduler finally marker missing')
text = text.replace(old, new, 1)

old = '''  clearInterval(lotterySchedulerTimer);
  lotterySchedulerTimer = null;
}'''
new = '''  clearInterval(lotterySchedulerTimer);
  lotterySchedulerTimer = null;
  lotterySchedulerBusy = false;
}'''
if old not in text:
    raise SystemExit('scheduler stop marker missing')
text = text.replace(old, new, 1)

p.write_text(text, encoding='utf-8')

# Extend safety regression.
t = Path('tests/security/economyLotterySafety.test.ts')
s = t.read_text(encoding='utf-8')
needle = "  it('archiviert Auditdaten nie per Cascade/Delete', () => {\n"
block = '''  it('behandelt parallele identische Ticketkaeufe als Replay statt als neues Limit-Ereignis', () => {
    expect(lottery).toContain('const purchaseReplay = await raw.$queryRawUnsafe');
    expect(lottery).toContain("WHERE \\\"idempotencyKey\\\"=$1 LIMIT 1");
    expect(lottery).toContain('return { firstPurchase: false };');
  });

  it('finalisiert Refunds nur bei wirklich leerem Pot und verhindert lokalen Scheduler-Overlap', () => {
    expect(lottery).toContain("if (terminal.potBalance !== 0n) throw new Error('Refund-Runde kann mit Restguthaben im Pot nicht finalisiert werden.')");
    expect(lottery).toContain('if (lotterySchedulerBusy) return;');
    expect(lottery).toContain('finally {');
    expect(lottery).toContain('lotterySchedulerBusy = false;');
  });

'''
if block not in s:
    if needle not in s:
        raise SystemExit('safety test insertion marker missing')
    s = s.replace(needle, block + needle, 1)
    t.write_text(s, encoding='utf-8')

print('lottery replay/refund/scheduler hardening applied')
