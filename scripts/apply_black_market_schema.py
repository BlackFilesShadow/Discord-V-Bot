from pathlib import Path

schema = Path('prisma/schema.prisma')
s = schema.read_text(encoding='utf-8')
s = s.replace(
'''  entries               EconomyVirtualAccountEntry[]
  lotteryRounds         LotteryRound[]
''',
'''  entries               EconomyVirtualAccountEntry[]
  lotteryRounds         LotteryRound[]
  marketListings        EconomyMarketListing[] @relation("MarketVendorListings")
  marketPurchases       EconomyMarketPurchase[] @relation("MarketVendorPurchases")
''', 1)
models = r'''

// Servergescoppter Schwarzmarkt (Etappe 6C). Geld liegt ausschliesslich auf dem
// bestehenden MARKET_VENDOR-Systemkonto; Listing/Purchase speichern nur
// fachliche Bestands- und Auditdaten.
model EconomyMarketListing {
  id                    String                @id @default(cuid())
  guildId               String
  nitradoConnId         String
  vendorAccountId       String
  vendorAccount         EconomyVirtualAccount @relation("MarketVendorListings", fields: [vendorAccountId], references: [id], onDelete: Restrict)
  sku                   String                @db.VarChar(80)
  name                  String                @db.VarChar(120)
  description           String?               @db.VarChar(500)
  price                 BigInt
  stock                 Int
  maxPerPurchase        Int                   @default(10)
  active                Boolean               @default(true)
  archivedAt            DateTime?
  archivedByDiscordId   String?
  createdByDiscordId    String
  createdAt             DateTime              @default(now())
  updatedAt             DateTime              @updatedAt
  purchases             EconomyMarketPurchase[]

  @@unique([guildId, nitradoConnId, sku], name: "scopeSku", map: "EconomyMarketListing_scope_sku_key")
  @@index([guildId, nitradoConnId, active], map: "EconomyMarketListing_scope_active_idx")
  @@index([vendorAccountId], map: "EconomyMarketListing_vendor_idx")
}

model EconomyMarketPurchase {
  id               String                @id @default(cuid())
  idempotencyKey   String                @unique(map: "EconomyMarketPurchase_idempotency_key") @db.VarChar(200)
  listingId        String
  listing          EconomyMarketListing  @relation(fields: [listingId], references: [id], onDelete: Restrict)
  guildId          String
  nitradoConnId    String
  vendorAccountId  String
  vendorAccount    EconomyVirtualAccount @relation("MarketVendorPurchases", fields: [vendorAccountId], references: [id], onDelete: Restrict)
  userDiscordId    String
  quantity         Int
  unitPrice        BigInt
  amount           BigInt
  createdAt        DateTime              @default(now())

  @@index([guildId, nitradoConnId, userDiscordId, createdAt], map: "EconomyMarketPurchase_scope_user_created_idx")
  @@index([listingId, createdAt], map: "EconomyMarketPurchase_listing_created_idx")
}
'''
marker = '\nenum EconomyTxType {\n'
if models.strip() not in s:
    if marker not in s:
        raise SystemExit('EconomyTxType marker missing')
    s = s.replace(marker, models + marker, 1)
s = s.replace('  LOTTERY_REFUND\n}', '  LOTTERY_REFUND\n  MARKET_PURCHASE\n}', 1)
schema.write_text(s, encoding='utf-8')

v2 = Path('src/dashboard/routes/v2.ts')
t = v2.read_text(encoding='utf-8')
t = t.replace(
"import { economyLotteryRouter } from './v2/economyLottery';\n",
"import { economyLotteryRouter } from './v2/economyLottery';\nimport { economyBlackMarketRouter } from './v2/economyBlackMarket';\n", 1)
t = t.replace(
"v2Router.use('/guilds/:guildId/economy/lottery', requireSafeDashboardEconomyScope, economyLotteryRouter);\n",
"v2Router.use('/guilds/:guildId/economy/lottery', requireSafeDashboardEconomyScope, economyLotteryRouter);\nv2Router.use('/guilds/:guildId/economy/black-market', requireSafeDashboardEconomyScope, economyBlackMarketRouter);\n", 1)
v2.write_text(t, encoding='utf-8')
print('black market schema/router wiring applied')
