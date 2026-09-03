process.env.NODE_ENV = 'test';
process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

import { randomUUID } from 'node:crypto';
import prisma from '../../src/database/prisma';
import { upsertConfig } from '../../src/modules/economy/repository';
import { deleteUnusedVirtualAccount } from '../../src/modules/economy/virtualAccountDeletion';
import { ensureVirtualAccountFinance } from '../../src/modules/economy/virtualAccountFinance';
import { createVirtualAccount } from '../../src/modules/economy/virtualAccounts';
import { asGuildId, asNitradoConnId, asUserDiscordId } from '../../src/types/scope';
import { describeDb } from '../helpers/dbIntegration';

const guildId = asGuildId('944456789012345678');
const actorId = asUserDiscordId('944456789012345679');
const buyerId = asUserDiscordId('944456789012345680');
const connId = asNitradoConnId('c777777777777777777777777');

async function cleanup(): Promise<void> {
  await prisma.economyMarketPurchase.deleteMany({ where: { guildId } });
  await prisma.economyMarketOrder.deleteMany({ where: { guildId } });
  await prisma.economyMarketListing.deleteMany({ where: { guildId } });
  await prisma.economyVirtualAccountEntry.deleteMany({ where: { guildId } });
  await prisma.economyVirtualAccount.deleteMany({ where: { guildId } });
  await prisma.$executeRawUnsafe(
    'DELETE FROM "EconomyVirtualAccountHistoryIdentity" WHERE "guildId"=$1 AND "nitradoConnId"=$2',
    String(guildId), String(connId),
  );
  await prisma.economyConfig.deleteMany({ where: { guildId } });
  await prisma.nitradoConnection.deleteMany({ where: { guildId } });
}

describeDb('virtual account terminal deletion history identity', () => {
  beforeEach(async () => {
    await cleanup();
    await prisma.nitradoConnection.create({
      data: {
        id: connId,
        guildId,
        slot: 1,
        alias: 'Terminal-Delete-Test',
        alias5: 'DEL01',
        encryptedToken: 'integration-token-terminal-delete',
        nitradoServerId: '90000030',
        status: 'ACTIVE',
        addedByDiscordId: actorId,
      },
    });
    await upsertConfig(guildId, connId, { enabled: true, startBalance: 0 });
  });

  afterEach(cleanup);

  it('physically removes the live CUSTOM row while preserving immutable history and rejecting new writes', async () => {
    const account = await createVirtualAccount({
      guildId,
      nitradoConnId: connId,
      name: 'Historienkonto',
      kind: 'CUSTOM',
      createdByDiscordId: actorId,
    });
    await ensureVirtualAccountFinance(guildId, connId, account.id);

    const oldEntryId = randomUUID();
    await prisma.$executeRawUnsafe(
      'INSERT INTO "EconomyVirtualAccountEntry" ("id","idempotencyKey","guildId","nitradoConnId","virtualAccountId","delta","entryType","sourcePocket","actorDiscordId","reason","sourceRef","createdAt") VALUES ($1,$2,$3,$4,$5,0,\'TEST_HISTORY\',\'WALLET\',$6,\'history sentinel\',\'terminal-delete-test\',CURRENT_TIMESTAMP)',
      oldEntryId,
      `terminal-delete-history:${randomUUID()}`,
      String(guildId),
      String(connId),
      account.id,
      String(actorId),
    );

    const listingId = `terminal-listing-${randomUUID()}`;
    await prisma.economyMarketListing.create({
      data: {
        id: listingId,
        guildId,
        nitradoConnId: connId,
        vendorAccountId: account.id,
        sku: `terminal-${randomUUID()}`,
        name: 'Historisches Angebot',
        price: 1n,
        stock: 0,
        active: false,
        createdByDiscordId: actorId,
      },
    });

    const result = await deleteUnusedVirtualAccount({
      guildId,
      nitradoConnId: connId,
      accountId: account.id,
      actorDiscordId: actorId,
    });
    expect(result.mode).toBe('HARD_DELETED');
    expect(result.walletRemoved).toBe('0');
    expect(result.bankRemoved).toBe('0');

    await expect(prisma.economyVirtualAccount.findUnique({ where: { id: account.id } })).resolves.toBeNull();
    await expect(prisma.economyVirtualAccountEntry.count({ where: { id: oldEntryId } })).resolves.toBe(1);
    await expect(prisma.economyMarketListing.count({ where: { id: listingId } })).resolves.toBe(1);

    const identity = await prisma.$queryRawUnsafe<Array<{ deletedAt: Date | null; nameSnapshot: string }>>(
      'SELECT "deletedAt", "nameSnapshot" FROM "EconomyVirtualAccountHistoryIdentity" WHERE "accountId"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3',
      account.id, String(guildId), String(connId),
    );
    expect(identity).toHaveLength(1);
    expect(identity[0]?.deletedAt).toBeInstanceOf(Date);
    expect(identity[0]?.nameSnapshot).toBe('Historienkonto');

    await expect(prisma.$executeRawUnsafe(
      'INSERT INTO "EconomyVirtualAccountEntry" ("id","idempotencyKey","guildId","nitradoConnId","virtualAccountId","delta","entryType","sourcePocket","actorDiscordId","reason","sourceRef","createdAt") VALUES ($1,$2,$3,$4,$5,0,\'TEST_AFTER_DELETE\',\'WALLET\',$6,\'must fail\',\'terminal-delete-test\',CURRENT_TIMESTAMP)',
      randomUUID(),
      `terminal-delete-after:${randomUUID()}`,
      String(guildId),
      String(connId),
      account.id,
      String(actorId),
    )).rejects.toThrow(/new virtual-account ledger entry requires a live account/);

    await expect(prisma.economyMarketListing.update({
      where: { id: listingId },
      data: { active: true },
    })).rejects.toThrow(/active market listing requires a live vendor account/);

    await expect(prisma.$executeRawUnsafe(
      'INSERT INTO "EconomyMarketPurchase" ("id","idempotencyKey","listingId","guildId","nitradoConnId","vendorAccountId","userDiscordId","sourcePocket","quantity","unitPrice","amount","createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7,\'WALLET\',1,1,1,CURRENT_TIMESTAMP)',
      randomUUID(),
      `terminal-purchase-after:${randomUUID()}`,
      listingId,
      String(guildId),
      String(connId),
      account.id,
      String(buyerId),
    )).rejects.toThrow(/new market purchase requires a live vendor account/);
  });
});