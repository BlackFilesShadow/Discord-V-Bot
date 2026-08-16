from pathlib import Path
p = Path('src/modules/economy/lottery.ts')
s = p.read_text(encoding='utf-8')
start_marker = "      const round = rounds[0];\n      if (!round) throw new Error('Lotterie nicht gefunden.');\n"
end_marker = "      const entries = await raw.$queryRawUnsafe<DbLotteryEntry[]>(\n"
start = s.find(start_marker, s.find('beforeClaim: async raw =>'))
if start < 0:
    raise SystemExit('preflight start missing')
end = s.find(end_marker, start)
if end < 0:
    raise SystemExit('preflight end missing')
replacement = '''      const round = rounds[0];
      if (!round) throw new Error('Lotterie nicht gefunden.');
      const replayPurchases = await raw.$queryRawUnsafe<Array<{ roundId: string; guildId: string; nitradoConnId: string; userDiscordId: string; ticketCount: number; amount: bigint }>>(
        'SELECT "roundId", "guildId", "nitradoConnId", "userDiscordId", "ticketCount", "amount" FROM "LotteryPurchase" WHERE "idempotencyKey"=$1 LIMIT 1',
        key,
      );
      const replay = replayPurchases[0];
      if (replay) {
        const same = replay.roundId === args.roundId
          && replay.guildId === String(args.guildId)
          && replay.nitradoConnId === String(args.nitradoConnId)
          && replay.userDiscordId === String(args.userDiscordId)
          && replay.ticketCount === args.quantity
          && replay.amount === amount;
        if (!same) throw new Error('Kauf-Idempotency-Key wurde mit anderen Daten wiederverwendet.');
        return { firstPurchase: false, replay: true };
      }
      if (round.status !== 'ACTIVE' || round.endsAt.getTime() <= Date.now()) throw new Error('Lotterie ist bereits geschlossen.');
      if (round.potAccountId !== initial.potAccountId || round.ticketPrice !== initial.ticketPrice) throw new Error('Lotterie-Konfiguration hat sich unerwartet veraendert.');
'''
s = s[:start] + replacement + s[end:]
p.write_text(s, encoding='utf-8')
print('lottery preflight normalized')