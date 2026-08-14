const fs = require('node:fs');

const path = 'prisma/schema.prisma';
let schema = fs.readFileSync(path, 'utf8');

const replacements = [
  [
`generator client {
  provider      = "prisma-client-js"
  binaryTargets = ["native", "linux-musl", "debian-openssl-3.0.x"]
}`,
`generator client {
  provider        = "prisma-client-js"
  binaryTargets   = ["native", "linux-musl", "debian-openssl-3.0.x"]
  previewFeatures = ["partialIndexes"]
}`
  ],
  [
`// Economy-Konfiguration pro Guild.
model EconomyConfig {
  id                    String   @id @default(cuid())
  guildId               String   @unique
  currencyName          String   @default("Coins") @db.VarChar(40)
  emoji                 String   @default("💰") @db.VarChar(40)
  enabled               Boolean  @default(false)
  startBalance          Int      @default(0) // bei guildMemberAdd, optional
  playtimeRewardPercent Int      @default(5) // 5..unbegrenzt — pro Spielminute Coins
  bankChannelId         String?
  bankInterestPercent   Int      @default(0) // pro Tag, optional
  createdAt             DateTime @default(now())
  updatedAt             DateTime @updatedAt

  @@index([guildId])
}`,
`// Economy-Konfiguration pro Guild + Gameserver. Nullable Scope nur fuer
// kontrollierte Legacy-Migration; neue Runtime-Writes setzen nitradoConnId.
model EconomyConfig {
  id                    String   @id @default(cuid())
  guildId               String
  nitradoConnId         String?
  currencyName          String   @default("Coins") @db.VarChar(40)
  emoji                 String   @default("💰") @db.VarChar(40)
  enabled               Boolean  @default(false)
  startBalance          Int      @default(0) // bei guildMemberAdd, optional
  playtimeRewardPercent Int      @default(5) // 5..unbegrenzt — pro Spielminute Coins
  bankChannelId         String?
  bankInterestPercent   Int      @default(0) // pro Tag, optional
  createdAt             DateTime @default(now())
  updatedAt             DateTime @updatedAt

  @@unique([guildId, nitradoConnId], name: "guildServer", map: "EconomyConfig_guildId_nitradoConnId_key")
  @@unique([guildId], name: "legacyGuildNullScope", map: "EconomyConfig_legacy_guild_key", where: { nitradoConnId: null })
  @@index([guildId])
  @@index([guildId, nitradoConnId], map: "EconomyConfig_guildId_nitradoConnId_idx")
}`
  ],
  [
`model BankInterestRun {
  id               String   @id @default(cuid())
  guildId          String
  runDate          String   @db.VarChar(10) // YYYY-MM-DD (Guild-Zeitzone)
  interestPercent  Int
  accountsCredited Int      @default(0)
  totalCredited    BigInt   @default(0)
  createdAt        DateTime @default(now())

  @@unique([guildId, runDate])
  @@index([guildId])
}`,
`model BankInterestRun {
  id               String   @id @default(cuid())
  guildId          String
  nitradoConnId    String?
  runDate          String   @db.VarChar(10) // YYYY-MM-DD (Guild-Zeitzone)
  interestPercent  Int
  accountsCredited Int      @default(0)
  totalCredited    BigInt   @default(0)
  createdAt        DateTime @default(now())

  @@unique([guildId, nitradoConnId, runDate], name: "guildServerRunDate", map: "BankInterestRun_guildId_nitradoConnId_runDate_key")
  @@unique([guildId, runDate], name: "legacyGuildRunDateNullScope", map: "BankInterestRun_legacy_guild_date_key", where: { nitradoConnId: null })
  @@index([guildId])
  @@index([guildId, nitradoConnId], map: "BankInterestRun_guildId_nitradoConnId_idx")
}`
  ],
  [
`model EconomyAccount {
  id             String   @id @default(cuid())
  guildId        String
  userDiscordId  String
  walletBalance  BigInt   @default(0) // direkt nutzbar (Casino, Pay)
  bankBalance    BigInt   @default(0) // sicher (Zinsen, Transfer)
  lifetimeEarned BigInt   @default(0)
  lifetimeSpent  BigInt   @default(0)
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  @@unique([guildId, userDiscordId])
  @@index([guildId])
}`,
`model EconomyAccount {
  id             String   @id @default(cuid())
  guildId        String
  nitradoConnId  String?
  userDiscordId  String
  walletBalance  BigInt   @default(0) // direkt nutzbar (Casino, Pay)
  bankBalance    BigInt   @default(0) // sicher (Zinsen, Transfer)
  lifetimeEarned BigInt   @default(0)
  lifetimeSpent  BigInt   @default(0)
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  @@unique([guildId, nitradoConnId, userDiscordId], name: "guildServerUser", map: "EconomyAccount_guildId_nitradoConnId_userDiscordId_key")
  @@unique([guildId, userDiscordId], name: "legacyGuildUserNullScope", map: "EconomyAccount_legacy_guild_user_key", where: { nitradoConnId: null })
  @@index([guildId])
  @@index([guildId, nitradoConnId], map: "EconomyAccount_guildId_nitradoConnId_idx")
}`
  ],
  [
`model EconomyTransaction {
  id                   String        @id @default(cuid())
  guildId              String
  userDiscordId        String // Empfaenger der Aenderung
  delta                BigInt // positiv = Gutschrift, negativ = Abzug
  type                 EconomyTxType
  reason               String?       @db.VarChar(200)
  actorDiscordId       String? // null bei System-Tx (Zinsen, Playtime)
  counterpartDiscordId String? // bei Pay/Transfer der Andere
  createdAt            DateTime      @default(now())

  @@index([guildId, userDiscordId, createdAt])
  @@index([guildId, createdAt])
}`,
`model EconomyTransaction {
  id                   String        @id @default(cuid())
  guildId              String
  nitradoConnId        String?
  userDiscordId        String // Empfaenger der Aenderung
  delta                BigInt // positiv = Gutschrift, negativ = Abzug
  type                 EconomyTxType
  reason               String?       @db.VarChar(200)
  actorDiscordId       String? // null bei System-Tx (Zinsen, Playtime)
  counterpartDiscordId String? // bei Pay/Transfer der Andere
  createdAt            DateTime      @default(now())

  @@index([guildId, userDiscordId, createdAt])
  @@index([guildId, createdAt])
  @@index([guildId, nitradoConnId, userDiscordId, createdAt], map: "EconomyTransaction_guildId_nitradoConnId_userDiscordId_createdAt_idx")
}`
  ],
  [
`// Spiel-Konfiguration pro Guild und Spieltyp.
model CasinoGame {
  id           String         @id @default(cuid())
  guildId      String
  type         CasinoGameType
  enabled      Boolean        @default(true)
  winChancePct Int            @default(45) // 1..99
  minBet       BigInt         @default(1)
  maxBet       BigInt         @default(10000)
  payoutMult   Float          @default(2.0) // Auszahlungsmultiplikator
  createdAt    DateTime       @default(now())
  updatedAt    DateTime       @updatedAt
  rounds       CasinoRound[]

  @@unique([guildId, type])
}`,
`// Spiel-Konfiguration pro Guild + Gameserver und Spieltyp.
model CasinoGame {
  id             String         @id @default(cuid())
  guildId        String
  nitradoConnId  String?
  type           CasinoGameType
  enabled        Boolean        @default(true)
  winChancePct   Int            @default(45) // 1..99
  minBet         BigInt         @default(1)
  maxBet         BigInt         @default(10000)
  payoutMult     Float          @default(2.0) // Auszahlungsmultiplikator
  createdAt      DateTime       @default(now())
  updatedAt      DateTime       @updatedAt
  rounds         CasinoRound[]

  @@unique([guildId, nitradoConnId, type], name: "guildServerType", map: "CasinoGame_guildId_nitradoConnId_type_key")
  @@unique([guildId, type], name: "legacyGuildTypeNullScope", map: "CasinoGame_legacy_guild_type_key", where: { nitradoConnId: null })
  @@index([guildId, nitradoConnId], map: "CasinoGame_guildId_nitradoConnId_idx")
}`
  ],
  [
`model CasinoRound {
  id            String     @id @default(cuid())
  gameId        String
  game          CasinoGame @relation(fields: [gameId], references: [id], onDelete: Cascade)
  guildId       String
  userDiscordId String
  bet           BigInt
  payout        BigInt     @default(0)
  result        Json // { won: bool, details: {...} }
  serverSeed    String     @db.VarChar(128)
  clientSeed    String?    @db.VarChar(128)
  nonce         BigInt     @default(0)
  createdAt     DateTime   @default(now())

  @@index([guildId, userDiscordId, createdAt])
  @@index([gameId, createdAt])
}`,
`model CasinoRound {
  id            String     @id @default(cuid())
  gameId        String
  game          CasinoGame @relation(fields: [gameId], references: [id], onDelete: Cascade)
  guildId       String
  nitradoConnId String?
  userDiscordId String
  bet           BigInt
  payout        BigInt     @default(0)
  result        Json // { won: bool, details: {...} }
  serverSeed    String     @db.VarChar(128)
  clientSeed    String?    @db.VarChar(128)
  nonce         BigInt     @default(0)
  createdAt     DateTime   @default(now())

  @@index([guildId, userDiscordId, createdAt])
  @@index([gameId, createdAt])
  @@index([guildId, nitradoConnId, userDiscordId, createdAt], map: "CasinoRound_guildId_nitradoConnId_userDiscordId_createdAt_idx")
}`
  ],
];

for (const [before, after] of replacements) {
  const first = schema.indexOf(before);
  const last = schema.lastIndexOf(before);
  if (first === -1 || first !== last) {
    throw new Error(`Expected schema block exactly once; found ${first === -1 ? 0 : 'multiple'} occurrences: ${before.slice(0, 100)}`);
  }
  schema = schema.replace(before, after);
}

fs.writeFileSync(path, schema);
console.log(`Applied ${replacements.length} exact schema replacements.`);
