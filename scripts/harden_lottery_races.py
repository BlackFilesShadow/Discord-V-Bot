from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text(encoding='utf-8')
    if new in text:
        return
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected one marker, found {count}')
    p.write_text(text.replace(old, new, 1), encoding='utf-8')

lottery = 'src/modules/economy/lottery.ts'
replace_once(lottery, "  if (!key || key.length > 80 || !/^[A-Za-z0-9._:-]+$/.test(key))", "  if (!key || key.length > 40 || !/^[A-Za-z0-9._:-]+$/.test(key))")
replace_once(
    lottery,
    "  const key = makePurchaseKey(args.roundId, args.idempotencyKey);\n  const existing = await prisma.lotteryPurchase.findUnique({ where: { idempotencyKey: key } });\n  if (existing) {\n    if (existing.userDiscordId !== String(args.userDiscordId) || existing.ticketCount !== args.quantity || existing.roundId !== args.roundId) {\n      throw new Error('Kauf-Idempotency-Key wurde mit anderen Daten wiederverwendet.');\n    }\n    const entry = await getLotteryEntry(args.roundId, args.userDiscordId);\n    const round = await fetchRoundViewById(args.roundId);\n    if (!entry || !round) throw new Error('Bestaetigter Lotteriekauf ist inkonsistent.');\n    return { booked: false, ...entry, round };\n  }\n\n  const initial = await fetchRoundViewById(args.roundId);\n  if (!initial || initial.guildId !== String(args.guildId) || initial.nitradoConnId !== String(args.nitradoConnId)) throw new Error('Lotterie nicht gefunden.');\n  const cfg = await getConfig(args.guildId, args.nitradoConnId);\n  if (!cfg.enabled) throw new Error('Economy ist auf diesem Gameserver deaktiviert.');\n  const amount = initial.ticketPrice * BigInt(args.quantity);",
    "  const key = makePurchaseKey(args.roundId, args.idempotencyKey);\n  const initial = await fetchRoundViewById(args.roundId);\n  if (!initial || initial.guildId !== String(args.guildId) || initial.nitradoConnId !== String(args.nitradoConnId)) throw new Error('Lotterie nicht gefunden.');\n  const amount = initial.ticketPrice * BigInt(args.quantity);\n  const existing = await prisma.lotteryPurchase.findUnique({ where: { idempotencyKey: key } });\n  if (existing) {\n    if (existing.userDiscordId !== String(args.userDiscordId)\n      || existing.ticketCount !== args.quantity\n      || existing.roundId !== args.roundId\n      || existing.guildId !== String(args.guildId)\n      || existing.nitradoConnId !== String(args.nitradoConnId)\n      || existing.amount !== amount) {\n      throw new Error('Kauf-Idempotency-Key wurde mit anderen Daten wiederverwendet.');\n    }\n    const entry = await getLotteryEntry(args.roundId, args.userDiscordId);\n    if (!entry) throw new Error('Bestaetigter Lotteriekauf ist inkonsistent.');\n    return { booked: false, ...entry, round: initial };\n  }\n\n  const cfg = await getConfig(args.guildId, args.nitradoConnId);\n  if (!cfg.enabled) throw new Error('Economy ist auf diesem Gameserver deaktiviert.');",
)
replace_once(
    lottery,
    "      if (round.potAccountId !== initial.potAccountId || round.ticketPrice !== initial.ticketPrice) throw new Error('Lotterie-Konfiguration hat sich unerwartet veraendert.');\n      const entries = await raw.$queryRawUnsafe<DbLotteryEntry[]>(",
    "      if (round.potAccountId !== initial.potAccountId || round.ticketPrice !== initial.ticketPrice) throw new Error('Lotterie-Konfiguration hat sich unerwartet veraendert.');\n      const replayPurchases = await raw.$queryRawUnsafe<Array<{ roundId: string; guildId: string; nitradoConnId: string; userDiscordId: string; ticketCount: number; amount: bigint }>>(\n        'SELECT \"roundId\", \"guildId\", \"nitradoConnId\", \"userDiscordId\", \"ticketCount\", \"amount\" FROM \"LotteryPurchase\" WHERE \"idempotencyKey\"=$1 LIMIT 1',\n        key,\n      );\n      const replay = replayPurchases[0];\n      if (replay) {\n        const same = replay.roundId === args.roundId\n          && replay.guildId === String(args.guildId)\n          && replay.nitradoConnId === String(args.nitradoConnId)\n          && replay.userDiscordId === String(args.userDiscordId)\n          && replay.ticketCount === args.quantity\n          && replay.amount === amount;\n        if (!same) throw new Error('Kauf-Idempotency-Key wurde mit anderen Daten wiederverwendet.');\n        return { firstPurchase: false, replay: true };\n      }\n      const entries = await raw.$queryRawUnsafe<DbLotteryEntry[]>(",
)
replace_once(
    lottery,
    "    if (totalTickets !== round.totalTickets || entries.length !== round.participantCount || pot.balance !== totalPaid) {",
    "    const entryScopeMismatch = entries.some(entry => entry.guildId !== round.guildId || entry.nitradoConnId !== round.nitradoConnId);\n    if (entryScopeMismatch || totalTickets !== round.totalTickets || entries.length !== round.participantCount || pot.balance !== totalPaid) {",
)
replace_once(
    lottery,
    "  await refreshLotteryMessage(client, roundId).catch(error => logger.warn(`Lotterie-Message-Update ${roundId}: ${(error as Error).message}`));\n  if (round.announcedAt) return;",
    "  await refreshLotteryMessage(client, roundId);\n  if (round.announcedAt) return;",
)

print('lottery race/integrity hardening applied')
