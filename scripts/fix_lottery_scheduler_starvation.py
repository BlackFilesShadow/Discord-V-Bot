from pathlib import Path

p = Path('src/modules/economy/lottery.ts')
s = p.read_text(encoding='utf-8')
old = '''      const rounds = await prisma.lotteryRound.findMany({
        where: {
          guildId: { in: guildIds },
          OR: [
            { status: 'ACTIVE', endsAt: { lte: new Date() } },
            { status: { in: ['DRAWING', 'REFUNDING'] } },
            { status: { in: ['FINISHED', 'REFUNDED'] }, announcedAt: null },
          ],
        },
        select: { id: true },
        orderBy: { endsAt: 'asc' },
        take: 100,
      });
      for (const round of rounds) {
        try { await settleLotteryRound(client, round.id); }
        catch (error) { logger.error(`Lotterie-Scheduler ${round.id}:`, error as Error); }
      }
'''
new = '''      // Geldkritische Settlement-Arbeit darf niemals hinter alten, nicht
      // zustellbaren Ergebnis-Ankuendigungen verhungern. Deshalb werden beide
      // Workloads getrennt begrenzt und Settlement-Runden immer zuerst verarbeitet.
      const settlementRounds = await prisma.lotteryRound.findMany({
        where: {
          guildId: { in: guildIds },
          OR: [
            { status: 'ACTIVE', endsAt: { lte: new Date() } },
            { status: { in: ['DRAWING', 'REFUNDING'] } },
          ],
        },
        select: { id: true },
        orderBy: { endsAt: 'asc' },
        take: 100,
      });
      for (const round of settlementRounds) {
        try { await settleLotteryRound(client, round.id); }
        catch (error) { logger.error(`Lotterie-Scheduler Settlement ${round.id}:`, error as Error); }
      }

      const announcementRounds = await prisma.lotteryRound.findMany({
        where: {
          guildId: { in: guildIds },
          status: { in: ['FINISHED', 'REFUNDED'] },
          announcedAt: null,
        },
        select: { id: true },
        orderBy: { endsAt: 'asc' },
        take: 100,
      });
      for (const round of announcementRounds) {
        try { await settleLotteryRound(client, round.id); }
        catch (error) { logger.error(`Lotterie-Scheduler Announcement ${round.id}:`, error as Error); }
      }
'''
if old not in s:
    raise SystemExit('scheduler block marker missing')
p.write_text(s.replace(old, new, 1), encoding='utf-8')

p = Path('tests/security/economyLotterySafety.test.ts')
t = p.read_text(encoding='utf-8')
marker = '''  it('verhindert endlose REFUNDED-Scheduler-Wiederholung durch announcedAt', () => {
'''
insert = '''  it('priorisiert geldkritische Settlement-Runden vor Ergebnis-Ankuendigungen und verhindert Scheduler-Starvation', () => {
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

'''
if marker not in t:
    raise SystemExit('test insertion marker missing')
p.write_text(t.replace(marker, insert + marker, 1), encoding='utf-8')
print('lottery scheduler starvation hardening applied')
