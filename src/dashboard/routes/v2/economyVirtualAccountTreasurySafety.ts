import { Router } from 'express';
import prisma from '../../../database/prisma';
import { requireGuildPermission } from '../../middleware/auth';
import { getVirtualAccountById, type VirtualAccountRawDb } from '../../../modules/economy/virtualAccounts';
import { getVirtualAccountMetadata } from '../../../modules/economy/virtualAccountMetadata';
import { ensureVirtualAccountFinance, listVirtualAccountManagers } from '../../../modules/economy/virtualAccountFinance';
import { ensureBankTreasurySerialized } from '../../../modules/economy/virtualAccountTreasury';
import { asUserDiscordId } from '../../../types/scope';

export const economyVirtualAccountTreasurySafetyRouter = Router({ mergeParams: true });

function rawDb(): VirtualAccountRawDb {
  return prisma as unknown as VirtualAccountRawDb;
}

async function readProjection(accountId: string, guildId: string, connId: string) {
  const rows = await rawDb().$queryRawUnsafe<Array<{
    channelId: string | null;
    messageId: string | null;
    archiveThreadId: string | null;
    lastSyncedAt: Date | null;
    lastSyncError: string | null;
  }>>(
    'SELECT "channelId", "messageId", "archiveThreadId", "lastSyncedAt", "lastSyncError" FROM "EconomyVirtualAccountProjection" WHERE "accountId"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 LIMIT 1',
    accountId,
    guildId,
    connId,
  );
  return rows[0] ?? null;
}

async function serializeTreasury(guildId: NonNullable<Express.Request['guildScope']>['guildId'], connId: NonNullable<Express.Request['guildScope']>['nitradoConnId'], accountId: string) {
  if (!connId) throw new Error('Economy-Gameserver-Scope fehlt.');
  const account = await getVirtualAccountById(guildId, connId, accountId);
  if (!account) throw new Error('Serverbank nicht gefunden.');
  const [finance, metadata, managers, projection] = await Promise.all([
    ensureVirtualAccountFinance(guildId, connId, accountId),
    getVirtualAccountMetadata(guildId, connId, accountId),
    listVirtualAccountManagers(guildId, connId, accountId),
    readProjection(accountId, String(guildId), String(connId)),
  ]);
  return {
    id: account.id,
    kind: account.kind,
    name: account.name,
    walletBalance: account.balance.toString(),
    bankBalance: finance.bankBalance.toString(),
    totalBalance: (account.balance + finance.bankBalance).toString(),
    status: account.status,
    acceptUserTransfers: account.acceptUserTransfers,
    expiresAt: account.expiresAt,
    archivedAt: account.archivedAt,
    createdAt: account.createdAt,
    description: metadata?.description ?? null,
    channelId: metadata?.channelId ?? null,
    currencyName: finance.currencyName,
    currencyEmoji: finance.currencyEmoji,
    accountEmoji: finance.accountEmoji,
    bannerUrl: finance.bannerUrl,
    textStyle: finance.textStyle,
    exchangePlayerUnits: finance.exchangePlayerUnits?.toString() ?? null,
    exchangeAccountUnits: finance.exchangeAccountUnits?.toString() ?? null,
    accountPurpose: finance.accountPurpose,
    managers: managers.map(manager => manager.userDiscordId),
    projection,
  };
}

// Mounted before the general control router so the race-safe implementation is
// authoritative for this exact endpoint.
economyVirtualAccountTreasurySafetyRouter.post('/control/bank-treasury', requireGuildPermission('economy.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const connId = scope.nitradoConnId;
  if (!connId) {
    res.status(400).json({ error: 'Economy-Gameserver-Scope fehlt.' });
    return;
  }
  try {
    const result = await ensureBankTreasurySerialized({
      guildId: scope.guildId,
      nitradoConnId: connId,
      createdByDiscordId: asUserDiscordId(scope.actorDiscordId),
    });
    res.json({ account: await serializeTreasury(scope.guildId, connId, result.account.id) });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});
