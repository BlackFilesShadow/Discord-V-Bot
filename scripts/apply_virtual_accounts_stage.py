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


schema_insert = r'''
// Virtuelle/temporäre Economy-Konten (Etappe 6A).
// Neue Konten sind ausnahmslos Guild+Gameserver-gescoppt. CUSTOM dient freien
// Community-Kassen; LOTTERY_POT und MARKET_VENDOR werden von den Folgeetappen
// auf derselben atomaren Infrastruktur verwendet.
enum EconomyVirtualAccountKind {
  CUSTOM
  LOTTERY_POT
  MARKET_VENDOR
}

enum EconomyVirtualAccountStatus {
  ACTIVE
  EXPIRED
  ARCHIVED
}

model EconomyVirtualAccount {
  id                    String                      @id @default(cuid())
  guildId               String
  nitradoConnId         String
  kind                  EconomyVirtualAccountKind   @default(CUSTOM)
  name                  String                      @db.VarChar(80)
  nameKey               String                      @db.VarChar(80)
  balance               BigInt                      @default(0)
  status                EconomyVirtualAccountStatus @default(ACTIVE)
  acceptUserTransfers   Boolean                     @default(true)
  expiresAt             DateTime?
  archivedAt            DateTime?
  archivedByDiscordId   String?
  createdByDiscordId    String
  createdAt             DateTime                    @default(now())
  updatedAt             DateTime                    @updatedAt
  entries               EconomyVirtualAccountEntry[]

  @@unique([guildId, nitradoConnId, nameKey], name: "guildServerNameKey", map: "EconomyVirtualAccount_guild_conn_name_key")
  @@index([guildId, nitradoConnId, status], map: "EconomyVirtualAccount_guild_conn_status_idx")
  @@index([guildId, nitradoConnId, expiresAt], map: "EconomyVirtualAccount_expiry_idx")
  @@index([guildId, nitradoConnId, kind], map: "EconomyVirtualAccount_kind_idx")
}

model EconomyVirtualAccountEntry {
  id                 String                @id @default(cuid())
  idempotencyKey     String                @unique @db.VarChar(200)
  guildId            String
  nitradoConnId      String
  virtualAccountId   String
  virtualAccount     EconomyVirtualAccount @relation(fields: [virtualAccountId], references: [id], onDelete: Restrict)
  delta              BigInt
  entryType          String                @db.VarChar(40)
  sourcePocket       String?               @db.VarChar(10)
  actorDiscordId     String?
  userDiscordId      String?
  reason             String?               @db.VarChar(200)
  sourceRef          String?               @db.VarChar(200)
  createdAt          DateTime              @default(now())

  @@index([guildId, nitradoConnId, virtualAccountId, createdAt], map: "EconomyVirtualAccountEntry_account_created_idx")
  @@index([guildId, nitradoConnId, userDiscordId, createdAt], map: "EconomyVirtualAccountEntry_user_created_idx")
}

'''

schema_path = Path('prisma/schema.prisma')
schema_text = schema_path.read_text(encoding='utf-8')
if 'model EconomyVirtualAccount {' not in schema_text:
    marker = 'enum EconomyTxType {'
    if schema_text.count(marker) != 1:
        raise SystemExit('prisma/schema.prisma: EconomyTxType marker missing/ambiguous')
    schema_path.write_text(schema_text.replace(marker, schema_insert + marker, 1), encoding='utf-8')

replace_once(
    'src/dashboard/routes/v2.ts',
    "import { economyRouter } from './v2/economy';\n",
    "import { economyRouter } from './v2/economy';\nimport { economyVirtualAccountsRouter } from './v2/economyVirtualAccounts';\n",
)
replace_once(
    'src/dashboard/routes/v2.ts',
    "v2Router.use('/guilds/:guildId/economy-scope', economyScopeRouter);\nv2Router.use('/guilds/:guildId/economy', requireSafeDashboardEconomyScope, economyRouter);\n",
    "v2Router.use('/guilds/:guildId/economy-scope', economyScopeRouter);\nv2Router.use('/guilds/:guildId/economy/virtual-accounts', requireSafeDashboardEconomyScope, economyVirtualAccountsRouter);\nv2Router.use('/guilds/:guildId/economy', requireSafeDashboardEconomyScope, economyRouter);\n",
)

replace_once(
    'dashboard-ui/src/pages/ServerSlot.tsx',
    "import { useGuildLiveUpdates } from '@/lib/useGuildLiveUpdates';\n",
    "import { useGuildLiveUpdates } from '@/lib/useGuildLiveUpdates';\nimport { VirtualAccountsPanel } from '@/components/economy/VirtualAccountsPanel';\n",
)
casino_marker = '''      <Card>\n        <CardHeader><CardTitle><span className="inline-flex items-center gap-2"><Dice5 className="h-4 w-4" />Casino-Games</span></CardTitle></CardHeader>\n'''
replace_once(
    'dashboard-ui/src/pages/ServerSlot.tsx',
    casino_marker,
    "      <VirtualAccountsPanel guildId={guildId} />\n\n" + casino_marker,
)

inventory = Path('src/commands/inventory.ts')
text = inventory.read_text(encoding='utf-8')
if "'virtual-account'" not in text:
    old = "  'giveaway', 'poll', 'ticket', 'factions', 'balance', 'bank', 'pay', 'transfer',\n"
    new = "  'giveaway', 'poll', 'ticket', 'factions', 'balance', 'bank', 'pay', 'transfer', 'virtual-account',\n"
    if text.count(old) != 1:
        raise SystemExit('src/commands/inventory.ts: DASHBOARD_EXTRA marker missing/ambiguous')
    text = text.replace(old, new, 1)
    old = "  'pay', 'slot', 'transfer', 'withdraw',\n"
    new = "  'pay', 'slot', 'transfer', 'withdraw', 'virtual-account',\n"
    if text.count(old) != 1:
        raise SystemExit('src/commands/inventory.ts: SPEC_KEEP marker missing/ambiguous')
    text = text.replace(old, new, 1)
    inventory.write_text(text, encoding='utf-8')

print('virtual account wiring applied')
