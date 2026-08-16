from pathlib import Path
p = Path('src/modules/economy/lottery.ts')
s = p.read_text(encoding='utf-8')
old = '''      const round = rounds[0];
      if (!round) throw new Error('Lotterie nicht gefunden.');
      if (round.status !== 'ACTIVE' || round.endsAt.getTime() <= Date.now()) throw new Error('Lotterie ist bereits geschlossen.');
      if (round.potAccountId !== initial.potAccountId || round.ticketPrice !== initial.ticketPrice) throw new Error('Lotterie-Konfiguration hat sich unerwartet veraendert.');
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
'''
new = '''      const round = rounds[0];
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
if old not in s:
    raise SystemExit('replay-order marker missing')
p.write_text(s.replace(old, new, 1), encoding='utf-8')
print('replay ordering fixed')