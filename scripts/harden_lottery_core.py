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

replace_once(
    'src/modules/economy/systemVirtualTransfers.ts',
    "function cleanText(value: string, max: number, label: string): string {\n  const normalized = value.normalize('NFKC').trim().replace(/\\s+/g, ' ');\n  if (!normalized || normalized.length > max || /[\\r\\n\\t\\u0000-\\u001f\\u007f]/.test(normalized)) {\n    throw new Error(`${label} ist ungueltig.`);\n  }\n  return normalized;\n}",
    "function cleanText(value: string, max: number, label: string): string {\n  const normalized = value.normalize('NFKC');\n  if (/[\\r\\n\\t\\u0000-\\u001f\\u007f]/.test(normalized)) throw new Error(`${label} ist ungueltig.`);\n  const clean = normalized.trim().replace(/\\s+/g, ' ');\n  if (!clean || clean.length > max) throw new Error(`${label} ist ungueltig.`);\n  return clean;\n}",
)

replace_once(
    'src/modules/economy/lottery.ts',
    "  await refreshLotteryMessage(client, roundId).catch(error => logger.warn(`Lotterie-Message-Update ${roundId}: ${(error as Error).message}`));\n  if (round.status !== 'FINISHED' || !round.winnerDiscordId || round.announcedAt) return;\n\n  const channel = await client.channels.fetch(round.channelId).catch(() => null);",
    "  await refreshLotteryMessage(client, roundId).catch(error => logger.warn(`Lotterie-Message-Update ${roundId}: ${(error as Error).message}`));\n  if (round.announcedAt) return;\n  if (round.status === 'REFUNDED') {\n    await prisma.lotteryRound.updateMany({ where: { id: round.id, status: 'REFUNDED', announcedAt: null }, data: { announcedAt: new Date() } });\n    return;\n  }\n  if (!round.winnerDiscordId) throw new Error('FINISHED-Lotterie ohne Gewinner kann nicht angekündigt werden.');\n\n  const channel = await client.channels.fetch(round.channelId).catch(() => null);",
)

print('lottery core hardened')
