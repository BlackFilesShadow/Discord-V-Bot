import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('virtuelle Economy-Konten — Production-Invarianten', () => {
  const schema = read('prisma/schema.prisma');
  const migration = read('prisma/migrations/20260816124500_economy_virtual_accounts/migration.sql');
  const service = read('src/modules/economy/virtualAccounts.ts');
  const routes = read('src/dashboard/routes/v2/economyVirtualAccounts.ts');
  const v2 = read('src/dashboard/routes/v2.ts');
  const command = read('src/commands/dashboard/virtualAccounts.ts');
  const inventory = read('src/commands/inventory.ts');
  const serverSlot = read('dashboard-ui/src/pages/ServerSlot.tsx');

  it('macht Guild + Gameserver fuer virtuelle Konten und deren Ledger zwingend', () => {
    expect(schema).toMatch(/model EconomyVirtualAccount \{[\s\S]*?guildId\s+String[\s\S]*?nitradoConnId\s+String\b/);
    expect(schema).toMatch(/model EconomyVirtualAccountEntry \{[\s\S]*?guildId\s+String[\s\S]*?nitradoConnId\s+String\b/);
    expect(schema).not.toMatch(/model EconomyVirtualAccount \{[\s\S]*?nitradoConnId\s+String\?/);
    expect(schema).not.toMatch(/model EconomyVirtualAccountEntry \{[\s\S]*?nitradoConnId\s+String\?/);
    expect(migration).toContain('"guildId" TEXT NOT NULL');
    expect(migration).toContain('"nitradoConnId" TEXT NOT NULL');
  });

  it('erzwingt DB-seitig Nichtnegativitaet, Eindeutigkeit, Idempotenz und Audit-Erhalt', () => {
    expect(migration).toContain('CONSTRAINT "EconomyVirtualAccount_balance_nonnegative" CHECK ("balance" >= 0)');
    expect(migration).toContain('CREATE UNIQUE INDEX "EconomyVirtualAccount_guild_conn_name_key"');
    expect(migration).toContain('CREATE UNIQUE INDEX "EconomyVirtualAccountEntry_idempotencyKey_key"');
    expect(migration).toContain('ON DELETE RESTRICT ON UPDATE CASCADE');
    expect(migration).not.toContain('ON DELETE CASCADE');
  });

  it('haelt Prisma-Schema und Migration beim Ablauf-Index identisch', () => {
    expect(schema).toContain('@@index([guildId, nitradoConnId, expiresAt], map: "EconomyVirtualAccount_expiry_idx")');
    expect(migration).toContain('ON "EconomyVirtualAccount"("guildId", "nitradoConnId", "expiresAt");');
    expect(migration).not.toMatch(/EconomyVirtualAccount_expiry_idx[\s\S]{0,180}WHERE\s+"expiresAt"/);
  });

  it('mountet die REST-Oberflaeche vor dem allgemeinen Economy-Router und hinter dem Scope-Guard', () => {
    const virtualMount = "v2Router.use('/guilds/:guildId/economy/virtual-accounts', requireSafeDashboardEconomyScope, economyVirtualAccountsRouter);";
    const genericMount = "v2Router.use('/guilds/:guildId/economy', requireSafeDashboardEconomyScope, economyRouter);";
    expect(v2).toContain(virtualMount);
    expect(v2.indexOf(virtualMount)).toBeLessThan(v2.indexOf(genericMount));
    expect(routes).toContain("requireGuildPermission('economy.view')");
    expect(routes).toContain("requireGuildPermission('economy.manage')");
  });

  it('bietet keine physische Delete-Route und verbietet Archivierung mit Restguthaben', () => {
    expect(routes).not.toMatch(/economyVirtualAccountsRouter\.delete\s*\(/);
    expect(service).toContain("if (current.balance !== 0n) throw new Error('Konto besitzt noch Guthaben");
    expect(service).toContain("' FOR UPDATE'");
  });

  it('verhindert Einzahlungen in inaktive oder fuer User gesperrte Konten', () => {
    expect(service).toContain("if (account.status !== 'ACTIVE') throw new Error('Virtuelles Konto ist nicht aktiv.')");
    expect(service).toContain("if (!account.acceptUserTransfers) throw new Error('Dieses Konto nimmt keine direkten User-Ueberweisungen an.')");
    expect(service).toContain('"expiresAt"<=CURRENT_TIMESTAMP');
  });

  it('verdrahtet Discord-Idempotenz, Live-Inventar und Dashboard-Verwaltung', () => {
    expect(command).toContain('idempotencyKey: `discord-virtual-pay:${i.id}`');
    expect(command).toContain(".setName('virtual-account')");
    expect(inventory).toContain("'virtual-account'");
    expect(serverSlot).toContain("import { VirtualAccountsPanel } from '@/components/economy/VirtualAccountsPanel';");
    expect(serverSlot).toContain('<VirtualAccountsPanel guildId={guildId} />');
  });

  it('nutzt eine einzige atomare Transaktion je Geldbewegung und getrennte Idempotenz-Ledger', () => {
    const transactionCount = (service.match(/return prisma\.\$transaction\(async tx =>/g) ?? []).length;
    expect(transactionCount).toBeGreaterThanOrEqual(3);
    expect(service).toContain('ON CONFLICT ("idempotencyKey") DO NOTHING');
    expect(service).toContain('return `virtual:${guildId}:${nitradoConnId}:${key}`;');
    expect(service).toContain('`${args.idempotencyKey}:user`');
    expect(service).toContain('`virtual-account:${args.virtualAccountId}`');
  });
});
