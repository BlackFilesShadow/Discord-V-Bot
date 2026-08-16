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

# Prisma schema: enum values + relations/models.
schema = Path('prisma/schema.prisma')
text = schema.read_text(encoding='utf-8')
if 'LOTTERY_TICKET' not in text:
    text = text.replace('  INTEREST\n}', '  INTEREST\n  LOTTERY_TICKET\n  LOTTERY_PAYOUT\n  LOTTERY_REFUND\n}', 1)
if 'lotteryRounds         LotteryRound[]' not in text:
    text = text.replace('  entries               EconomyVirtualAccountEntry[]\n', '  entries               EconomyVirtualAccountEntry[]\n  lotteryRounds         LotteryRound[]\n', 1)
if 'model LotteryRound {' not in text:
    marker = 'enum EconomyTxType {'
    block = '''enum LotteryRoundStatus {
  ACTIVE
  DRAWING
  REFUNDING
  FINISHED
  REFUNDED
}

model LotteryRound {
  id                    String             @id @default(cuid())
  guildId               String
  nitradoConnId         String
  potAccountId          String
  potAccount            EconomyVirtualAccount @relation(fields: [potAccountId], references: [id], onDelete: Restrict)
  channelId             String
  messageId             String?
  ticketPrice           BigInt
  maxTicketsPerUser     Int
  minParticipants       Int
  status                LotteryRoundStatus @default(ACTIVE)
  activeScopeKey        String?            @unique(map: "LotteryRound_activeScopeKey_key") @db.VarChar(160)
  endsAt                DateTime
  winnerDiscordId       String?
  winningTicketNumber   Int?
  participantCount      Int                @default(0)
  totalTickets          Int                @default(0)
  finalPot              BigInt?
  drawnAt               DateTime?
  settledAt             DateTime?
  announcedAt           DateTime?
  createdByDiscordId    String
  createdAt             DateTime           @default(now())
  updatedAt             DateTime           @updatedAt
  entries               LotteryEntry[]
  purchases             LotteryPurchase[]

  @@index([guildId, nitradoConnId, status, endsAt], map: "LotteryRound_scope_status_ends_idx")
  @@index([guildId, nitradoConnId, createdAt], map: "LotteryRound_scope_created_idx")
}

model LotteryEntry {
  id                String       @id @default(cuid())
  roundId           String
  round             LotteryRound @relation(fields: [roundId], references: [id], onDelete: Restrict)
  guildId           String
  nitradoConnId     String
  userDiscordId     String
  ticketCount       Int
  totalPaid         BigInt
  refundedAt        DateTime?
  createdAt         DateTime     @default(now())
  updatedAt         DateTime     @updatedAt

  @@unique([roundId, userDiscordId], name: "roundUser", map: "LotteryEntry_round_user_key")
  @@index([guildId, nitradoConnId, userDiscordId], map: "LotteryEntry_scope_user_idx")
  @@index([roundId, refundedAt], map: "LotteryEntry_round_refund_idx")
}

model LotteryPurchase {
  id              String       @id @default(cuid())
  idempotencyKey  String       @unique(map: "LotteryPurchase_idempotencyKey_key") @db.VarChar(200)
  roundId         String
  round           LotteryRound @relation(fields: [roundId], references: [id], onDelete: Restrict)
  guildId         String
  nitradoConnId   String
  userDiscordId   String
  ticketCount     Int
  amount          BigInt
  createdAt       DateTime     @default(now())

  @@index([roundId, userDiscordId, createdAt], map: "LotteryPurchase_round_user_created_idx")
}

'''
    if text.count(marker) != 1:
        raise SystemExit('schema: EconomyTxType marker missing/ambiguous')
    text = text.replace(marker, block + marker, 1)
schema.write_text(text, encoding='utf-8')

# Dashboard router.
replace_once(
    'src/dashboard/routes/v2.ts',
    "import { economyVirtualAccountsRouter } from './v2/economyVirtualAccounts';\n",
    "import { economyVirtualAccountsRouter } from './v2/economyVirtualAccounts';\nimport { economyLotteryRouter } from './v2/economyLottery';\n",
)
replace_once(
    'src/dashboard/routes/v2.ts',
    "v2Router.use('/guilds/:guildId/economy/virtual-accounts', requireSafeDashboardEconomyScope, economyVirtualAccountsRouter);\n",
    "v2Router.use('/guilds/:guildId/economy/virtual-accounts', requireSafeDashboardEconomyScope, economyVirtualAccountsRouter);\nv2Router.use('/guilds/:guildId/economy/lottery', requireSafeDashboardEconomyScope, economyLotteryRouter);\n",
)

# Economy dashboard UI.
replace_once(
    'dashboard-ui/src/pages/ServerSlot.tsx',
    "import { VirtualAccountsPanel } from '@/components/economy/VirtualAccountsPanel';\n",
    "import { VirtualAccountsPanel } from '@/components/economy/VirtualAccountsPanel';\nimport { LotteryPanel } from '@/components/economy/LotteryPanel';\n",
)
replace_once(
    'dashboard-ui/src/pages/ServerSlot.tsx',
    "      <VirtualAccountsPanel guildId={guildId} />\n\n",
    "      <VirtualAccountsPanel guildId={guildId} />\n\n      <LotteryPanel guildId={guildId} />\n\n",
)

# Command inventory.
inventory = Path('src/commands/inventory.ts')
text = inventory.read_text(encoding='utf-8')
if "'lottery'" not in text:
    text = text.replace("'transfer', 'virtual-account',", "'transfer', 'virtual-account', 'lottery',", 1)
    text = text.replace("'withdraw', 'virtual-account',", "'withdraw', 'virtual-account', 'lottery',", 1)
    inventory.write_text(text, encoding='utf-8')

# Central interaction button dispatcher.
replace_once(
    'src/events/interactionCreate.ts',
    "      if (button.customId.startsWith('giveaway_enter_')) {\n        await handleGiveawayEnterButton(button);\n        return;\n      }\n",
    "      if (button.customId.startsWith('giveaway_enter_')) {\n        await handleGiveawayEnterButton(button);\n        return;\n      }\n      if (button.customId.startsWith('lottery_buy_')) {\n        try {\n          const { handleLotteryBuyButton } = await import('../modules/economy/lottery.js');\n          await handleLotteryBuyButton(button);\n        } catch (error) {\n          logger.error('Lottery-Button-Handler-Fehler:', error as Error);\n        }\n        return;\n      }\n",
)

# Runtime scheduler start/stop.
replace_once(
    'src/index.ts',
    "import { startGiveawayScheduler, stopGiveawayScheduler } from './modules/giveaway/giveawayManager';\n",
    "import { startGiveawayScheduler, stopGiveawayScheduler } from './modules/giveaway/giveawayManager';\nimport { startLotteryScheduler, stopLotteryScheduler } from './modules/economy/lottery';\n",
)
replace_once(
    'src/index.ts',
    "  startGiveawayScheduler(client);\n  startFeedScheduler(client);\n",
    "  startGiveawayScheduler(client);\n  startLotteryScheduler(client);\n  startFeedScheduler(client);\n",
)
replace_once(
    'src/index.ts',
    "    stopGiveawayScheduler();\n\n    try {\n",
    "    stopGiveawayScheduler();\n    stopLotteryScheduler();\n\n    try {\n",
)

print('lottery wiring applied')
