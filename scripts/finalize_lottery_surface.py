from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text(encoding='utf-8')
    if new in text:
        return
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected exactly one marker, found {count}')
    p.write_text(text.replace(old, new, 1), encoding='utf-8')

replace_once(
    'src/commands/dashboard/lottery.ts',
    "  getLotteryEntry,\n} from '../../modules/economy/lottery';",
    "  getLotteryEntry,\n  refreshLotteryMessage,\n} from '../../modules/economy/lottery';",
)
replace_once(
    'src/commands/dashboard/lottery.ts',
    "import { logAudit } from '../../utils/logger';",
    "import { logger, logAudit } from '../../utils/logger';",
)
replace_once(
    'src/commands/dashboard/lottery.ts',
    "        logAudit('LOTTERY_BUY_COMMAND', 'ECONOMY', {\n          guildId: scope.guildId,\n          nitradoConnId: connId,\n          roundId: round.id,\n          userDiscordId: scope.actorDiscordId,\n          quantity,\n          booked: result.booked,\n        });\n        await interaction.reply({",
    "        logAudit('LOTTERY_BUY_COMMAND', 'ECONOMY', {\n          guildId: scope.guildId,\n          nitradoConnId: connId,\n          roundId: round.id,\n          userDiscordId: scope.actorDiscordId,\n          quantity,\n          booked: result.booked,\n        });\n        await refreshLotteryMessage(interaction.client, round.id).catch(error => {\n          logger.warn(`Lotterie-Embed-Refresh nach Slash-Kauf ${round.id}: ${(error as Error).message}`);\n        });\n        await interaction.reply({",
)

replace_once(
    'src/modules/economy/lottery.ts',
    "  const roundId = randomUUID();\n  const potId = randomUUID();\n  const preview: LotteryRoundView = {",
    "  const roundId = randomUUID();\n  const potId = randomUUID();\n  const potName = `Lotterie ${roundId}`;\n  const preview: LotteryRoundView = {",
)
replace_once(
    'src/modules/economy/lottery.ts',
    "          name: `Lotterie ${roundId.slice(0, 8)}`,\n          nameKey: `lotterie-${roundId}`,,",
    "          name: potName,\n          nameKey: potName.toLowerCase(),",
)
# tolerate correct marker without accidental double comma
p = Path('src/modules/economy/lottery.ts')
t = p.read_text(encoding='utf-8')
old = "          name: `Lotterie ${roundId.slice(0, 8)}`,\n          nameKey: `lotterie-${roundId}`,\n"
new = "          name: potName,\n          nameKey: potName.toLowerCase(),\n"
if old in t:
    p.write_text(t.replace(old, new, 1), encoding='utf-8')
elif new not in t:
    raise SystemExit('lottery pot name marker missing')

replace_once(
    'src/modules/economy/lottery.ts',
    "    await refreshLotteryMessage(interaction.client, roundId).catch(() => undefined);",
    "    await refreshLotteryMessage(interaction.client, roundId).catch(error => {\n      logger.warn(`Lotterie-Embed-Refresh nach Button-Kauf ${roundId}: ${(error as Error).message}`);\n    });",
)

replace_once(
    'tests/security/economyLotteryIntegration.test.ts',
    "    expect(command).toContain('idempotencyKey: `discord-slash:${interaction.id}`');\n    expect(inventory).toContain(\"'lottery'\");",
    "    expect(command).toContain('idempotencyKey: `discord-slash:${interaction.id}`');\n    expect(command).toContain('await refreshLotteryMessage(interaction.client, round.id)');\n    expect(command).toContain('Lotterie-Embed-Refresh nach Slash-Kauf');\n    expect(inventory).toContain(\"'lottery'\");",
)
replace_once(
    'tests/security/economyLotteryIntegration.test.ts',
    "    expect(interaction).toContain('handleLotteryBuyButton');\n    expect(index).toContain",
    "    expect(interaction).toContain('handleLotteryBuyButton');\n    const lottery = read('src/modules/economy/lottery.ts');\n    expect(lottery).toContain('Lotterie-Embed-Refresh nach Button-Kauf');\n    expect(lottery).toContain('const potName = `Lotterie ${roundId}`;');\n    expect(lottery).toContain('nameKey: potName.toLowerCase()');\n    expect(index).toContain",
)

print('lottery surfaces finalized')