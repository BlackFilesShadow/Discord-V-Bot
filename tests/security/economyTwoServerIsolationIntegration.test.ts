process.env.NODE_ENV = 'test';
process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

import prisma from '../../src/database/prisma';
import {
  getAccountOrZero,
  maybeGrantStartBalance,
  pay,
  upsertConfig,
} from '../../src/modules/economy/repository';
import {
  asGuildId,
  asNitradoConnId,
  asUserDiscordId,
} from '../../src/types/scope';

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

const guildId = asGuildId('823456789012345678');
const ownerId = asUserDiscordId('823456789012345679');
const payerId = asUserDiscordId('823456789012345680');
const targetId = asUserDiscordId('823456789012345681');
const connA = asNitradoConnId('c111111111111111111111111');
const connB = asNitradoConnId('c222222222222222222222222');

async function cleanup(): Promise<void> {
  await prisma.economyLedgerEntry.deleteMany({ where: { guildId } });
  await prisma.economyTransaction.deleteMany({ where: { guildId } });
  await prisma.economyAccount.deleteMany({ where: { guildId } });
  await prisma.economyConfig.deleteMany({ where: { guildId } });
  await prisma.economyScopeMigration.deleteMany({ where: { guildId } });
  await prisma.nitradoConnection.deleteMany({ where: { guildId } });
}

describeDb('Phase 4 Economy PostgreSQL two-server isolation', () => {
  beforeEach(async () => {
    await cleanup();
    await prisma.nitradoConnection.createMany({
      data: [
        {
          id: connA,
          guildId,
          slot: 1,
          alias: 'Phase4-A',
          alias5: 'E4A01',
          encryptedToken: 'integration-token-a',
          nitradoServerId: 'phase4-server-a',
          status: 'ACTIVE',
          addedByDiscordId: ownerId,
        },
        {
          id: connB,
          guildId,
          slot: 2,
          alias: 'Phase4-B',
          alias5: 'E4B02',
          encryptedToken: 'integration-token-b',
          nitradoServerId: 'phase4-server-b',
          status: 'ACTIVE',
          addedByDiscordId: ownerId,
        },
      ],
    });
  });

  afterEach(cleanup);

  it('haelt Konten, Config und Pay derselben Discord-User physisch pro Gameserver getrennt', async () => {
    await upsertConfig(guildId, connA, { enabled: true, startBalance: 1_000 });
    await upsertConfig(guildId, connB, { enabled: true, startBalance: 5_000 });

    await expect(maybeGrantStartBalance(guildId, connA, payerId))
      .resolves.toEqual({ granted: true, amount: 1_000n });
    await expect(maybeGrantStartBalance(guildId, connB, payerId))
      .resolves.toEqual({ granted: true, amount: 5_000n });
    await expect(maybeGrantStartBalance(guildId, connB, targetId))
      .resolves.toEqual({ granted: true, amount: 5_000n });

    await pay({
      guildId,
      nitradoConnId: connA,
      fromUserId: payerId,
      toUserId: targetId,
      amount: 250n,
      reason: 'Phase-4-Isolationstest',
    });

    const [payerA, payerB, targetA, targetB] = await Promise.all([
      getAccountOrZero(guildId, connA, payerId),
      getAccountOrZero(guildId, connB, payerId),
      getAccountOrZero(guildId, connA, targetId),
      getAccountOrZero(guildId, connB, targetId),
    ]);

    expect(payerA.walletBalance).toBe(750n);
    expect(targetA.walletBalance).toBe(250n);
    expect(payerB.walletBalance).toBe(5_000n);
    expect(targetB.walletBalance).toBe(5_000n);

    const payerRows = await prisma.economyAccount.findMany({
      where: { guildId, userDiscordId: payerId },
      orderBy: { nitradoConnId: 'asc' },
      select: { nitradoConnId: true, walletBalance: true },
    });
    expect(payerRows).toEqual([
      { nitradoConnId: connA, walletBalance: 750n },
      { nitradoConnId: connB, walletBalance: 5_000n },
    ]);

    const configs = await prisma.economyConfig.findMany({
      where: { guildId },
      orderBy: { nitradoConnId: 'asc' },
      select: { nitradoConnId: true, startBalance: true },
    });
    expect(configs).toEqual([
      { nitradoConnId: connA, startBalance: 1_000 },
      { nitradoConnId: connB, startBalance: 5_000 },
    ]);

    const payTx = await prisma.economyTransaction.findMany({
      where: { guildId, type: 'PAY' },
      select: { nitradoConnId: true },
    });
    expect(payTx).toHaveLength(2);
    expect(payTx.every(row => row.nitradoConnId === connA)).toBe(true);
  });
});
