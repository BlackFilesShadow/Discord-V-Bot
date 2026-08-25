import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('virtuelle Economy-Konten — Production-Invarianten', () => {
  const schema = read('prisma/schema.prisma');
  const migration = read('prisma/migrations/20260816124500_economy_virtual_accounts/migration.sql');
  const extensionMigration = read('prisma/migrations/20260826190000_virtual_account_wallet_bank_currency_projection/migration.sql');
  const permissionMigration = read('prisma/migrations/20260826193000_virtual_manager_permission_restore/migration.sql');
  const service = read('src/modules/economy/virtualAccounts.ts');
  const moneySafety = read('src/modules/economy/virtualAccountMoneySafety.ts');
  const configuration = read('src/modules/economy/virtualAccountConfiguration.ts');
  const treasury = read('src/modules/economy/virtualAccountTreasury.ts');
  const controlSafety = read('src/dashboard/routes/v2/economyVirtualAccountTreasurySafety.ts');
  const routes = read('src/dashboard/routes/v2/economyVirtualAccounts.ts');
  const v2 = read('src/dashboard/routes/v2.ts');
  const command = read('src/commands/dashboard/virtualAccounts.ts');
  const inventory = read('src/commands/inventory.ts');
  const serverSlot = read('dashboard-ui/src/pages/ServerSlot.tsx');

  it('macht Guild + Gameserver fuer virtuelle Konten und deren Ledger zwingend', () => {
    expect(schema).toMatch(/model EconomyVirtualAccount \{[^}]*?guildId\s+String[^}]*?nitradoConnId\s+String\b/s);
    expect(schema).toMatch(/model EconomyVirtualAccountEntry \{[^}]*?guildId\s+String[^}]*?nitradoConnId\s+String\b/s);
    expect(schema).not.toMatch(/model EconomyVirtualAccount \{[^}]*?nitradoConnId\s+String\?/s);
    expect(schema).not.toMatch(/model EconomyVirtualAccountEntry \{[^}]*?nitradoConnId\s+String\?/s);
    expect(migration).toContain('"guildId" TEXT NOT NULL');
    expect(migration).toContain('"nitradoConnId" TEXT NOT NULL');
  });

  it('erzwingt DB-seitig Nichtnegativitaet, Eindeutigkeit, Idempotenz und Audit-Erhalt', () => {
    expect(migration).toContain('CONSTRAINT "EconomyVirtualAccount_balance_nonnegative" CHECK ("balance" >= 0)');
    expect(migration).toContain('CREATE UNIQUE INDEX "EconomyVirtualAccount_guild_conn_name_key"');
    expect(migration).toContain('CREATE UNIQUE INDEX "EconomyVirtualAccountEntry_idempotencyKey_key"');
    expect(migration).toContain('ON DELETE RESTRICT ON UPDATE CASCADE');
    expect(migration).not.toContain('ON DELETE CASCADE');
    expect(extensionMigration).toContain('"bankBalance" BIGINT NOT NULL DEFAULT 0');
    expect(extensionMigration).toContain('EconomyVirtualAccountFinance_bank_nonnegative');
    expect(extensionMigration).toContain('EconomyVirtualAccountFinance_one_bank_treasury_per_scope');
  });

  it('haelt Prisma-Schema und Migration beim Ablauf-Index identisch', () => {
    expect(schema).toContain('@@index([guildId, nitradoConnId, expiresAt], map: "EconomyVirtualAccount_expiry_idx")');
    expect(migration).toContain('ON "EconomyVirtualAccount"("guildId", "nitradoConnId", "expiresAt");');
    expect(migration).not.toMatch(/EconomyVirtualAccount_expiry_idx[\s\S]{0,180}WHERE\s+"expiresAt"/);
  });

  it('mountet Safety-, Control- und Legacy-Router in dieser Reihenfolge vor dem allgemeinen Economy-Router', () => {
    const mountStart = "'/guilds/:guildId/economy/virtual-accounts'";
    const genericMount = "v2Router.use('/guilds/:guildId/economy', requireEconomyDashboardAccess, requireSafeDashboardEconomyScope, economyRouter);";
    expect(v2).toContain('economyVirtualAccountTreasurySafetyRouter');
    expect(v2).toContain('economyVirtualAccountControlRouter');
    expect(v2).toContain('economyVirtualAccountsRouter');
    expect(v2.indexOf(mountStart)).toBeLessThan(v2.indexOf(genericMount));
    expect(v2.indexOf('economyVirtualAccountTreasurySafetyRouter')).toBeLessThan(v2.indexOf('economyVirtualAccountControlRouter'));
    expect(controlSafety).toContain("post('/control/accounts'");
    expect(controlSafety).toContain("put('/control/accounts/:accountId'");
    expect(controlSafety).toContain("post('/control/bank-treasury'");
    expect(controlSafety).toContain("post('/:accountId/payout'");
    expect(routes).toContain("requireGuildPermission('economy.view')");
    expect(routes).toContain("requireGuildPermission('economy.manage')");
  });

  it('bietet keine physische Delete-Route und verbietet Archivierung mit Restguthaben', () => {
    expect(routes).not.toMatch(/economyVirtualAccountsRouter\.delete\s*\(/);
    expect(service).toContain("if (current.balance !== 0n) throw new Error('Konto besitzt noch Guthaben");
    expect(service).toContain("' FOR UPDATE'");
    expect(controlSafety).toContain("account.kind !== 'CUSTOM'");
  });

  it('verhindert Einzahlungen in inaktive oder fuer User gesperrte Konten', () => {
    expect(service).toContain("if (account.status !== 'ACTIVE') throw new Error('Virtuelles Konto ist nicht aktiv.')");
    expect(service).toContain("if (!account.acceptUserTransfers) throw new Error('Dieses Konto nimmt keine direkten User-Ueberweisungen an.')");
    expect(service).toContain('"expiresAt"<=CURRENT_TIMESTAMP');
    expect(moneySafety).toContain('await assertCustomAccount');
  });

  it('verdrahtet Discord-Idempotenz, Live-Inventar und slotgescoppte Dashboard-Verwaltung', () => {
    expect(command).toContain('idempotencyKey: `discord-virtual-pay:${i.id}`');
    expect(command).toContain('safeDepositUserIntoVirtualAccount');
    expect(command).toContain(".setName('virtual-account')");
    expect(inventory).toContain("'virtual-account'");
    expect(serverSlot).toContain("import { VirtualAccountsPanel } from '@/components/economy/VirtualAccountsPanel';");
    expect(serverSlot).toContain('<VirtualAccountsPanel guildId={guildId} slot={slot} />');
  });

  it('nutzt atomare Geldbewegungen, vollstaendige Replay-Pruefung und atomare Konto-Konfiguration', () => {
    const transactionCount = (service.match(/return prisma\.\$transaction\(async tx =>/g) ?? []).length;
    expect(transactionCount).toBeGreaterThanOrEqual(3);
    expect(service).toContain('ON CONFLICT ("idempotencyKey") DO NOTHING');
    expect(service).toContain('return `virtual:${guildId}:${nitradoConnId}:${key}`;');
    expect(service).toContain('`${args.idempotencyKey}:user`');
    expect(moneySafety).toContain('Idempotency-Key wurde mit anderen Buchungsdaten wiederverwendet.');
    expect(moneySafety).toContain('actual.virtualAccountId === expected.virtualAccountId');
    expect(configuration).toContain('await prisma.$transaction(async tx =>');
    expect(configuration).toContain('INSERT INTO "EconomyVirtualAccountFinance"');
    expect(configuration).toContain('INSERT INTO "EconomyVirtualAccountManager"');
  });

  it('serialisiert genau eine Serverbank und stellt V-Bot-eigene Managerrechte wieder her', () => {
    expect(treasury).toContain('pg_advisory_xact_lock');
    expect(treasury).toContain("'BANK_TREASURY'");
    expect(permissionMigration).toContain('"previousViewChannel" SMALLINT');
    expect(permissionMigration).toContain('"previousEveryoneView" SMALLINT');
  });
});
