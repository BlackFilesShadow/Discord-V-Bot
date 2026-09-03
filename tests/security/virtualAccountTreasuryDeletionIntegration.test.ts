process.env.NODE_ENV = 'test';
process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

import prisma from '../../src/database/prisma';
import { upsertConfig } from '../../src/modules/economy/repository';
import { deleteUnusedVirtualAccount } from '../../src/modules/economy/virtualAccountDeletion';
import { ensureBankTreasurySerialized } from '../../src/modules/economy/virtualAccountTreasury';
import { asGuildId, asNitradoConnId, asUserDiscordId } from '../../src/types/scope';
import { describeDb } from '../helpers/dbIntegration';

const guildId = asGuildId('955556789012345678');
const actorId = asUserDiscordId('955556789012345679');
const connId = asNitradoConnId('c888888888888888888888888');

async function cleanup(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'DELETE FROM "EconomyVirtualAccountProjection" WHERE "guildId"=$1 AND "nitradoConnId"=$2',
    String(guildId), String(connId),
  );
  await prisma.economyVirtualAccount.deleteMany({ where: { guildId } });
  await prisma.$executeRawUnsafe(
    'DELETE FROM "EconomyVirtualAccountHistoryIdentity" WHERE "guildId"=$1 AND "nitradoConnId"=$2',
    String(guildId), String(connId),
  );
  await prisma.economyConfig.deleteMany({ where: { guildId } });
  await prisma.nitradoConnection.deleteMany({ where: { guildId } });
}

describeDb('Serverbank generic deletion guard', () => {
  beforeEach(async () => {
    await cleanup();
    await prisma.nitradoConnection.create({
      data: {
        id: connId,
        guildId,
        slot: 1,
        alias: 'Treasury-Delete-Test',
        alias5: 'BANK1',
        encryptedToken: 'integration-token-treasury-delete',
        nitradoServerId: '90000031',
        status: 'ACTIVE',
        addedByDiscordId: actorId,
      },
    });
    await upsertConfig(guildId, connId, { enabled: true, startBalance: 0 });
  });

  afterEach(cleanup);

  it('keeps an empty BANK_TREASURY live and undeleted when generic deletion is attempted', async () => {
    const treasury = await ensureBankTreasurySerialized({
      guildId,
      nitradoConnId: connId,
      createdByDiscordId: actorId,
    });

    expect(treasury.account.kind).toBe('CUSTOM');
    expect(treasury.finance.accountPurpose).toBe('BANK_TREASURY');
    expect(treasury.account.balance).toBe(0n);
    expect(treasury.finance.bankBalance).toBe(0n);

    await expect(deleteUnusedVirtualAccount({
      guildId,
      nitradoConnId: connId,
      accountId: treasury.account.id,
      actorDiscordId: actorId,
    })).rejects.toThrow(/Serverbank-Konten werden ausschließlich über die Serverbank-Funktion verwaltet/);

    const live = await prisma.economyVirtualAccount.findUnique({ where: { id: treasury.account.id } });
    expect(live?.id).toBe(treasury.account.id);

    const identities = await prisma.$queryRawUnsafe<Array<{ deletedAt: Date | null }>>(
      'SELECT "deletedAt" FROM "EconomyVirtualAccountHistoryIdentity" WHERE "accountId"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3',
      treasury.account.id,
      String(guildId),
      String(connId),
    );
    expect(identities).toHaveLength(1);
    expect(identities[0]?.deletedAt).toBeNull();
  });
});
