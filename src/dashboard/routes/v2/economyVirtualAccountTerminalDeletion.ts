import { Router } from 'express';
import prisma from '../../../database/prisma';
import { requireGuildPermission } from '../../middleware/auth';
import { getVirtualAccountById, listVirtualAccounts, type VirtualAccountRawDb } from '../../../modules/economy/virtualAccounts';
import { getVirtualAccountMetadata } from '../../../modules/economy/virtualAccountMetadata';
import { ensureVirtualAccountFinance, listVirtualAccountManagers } from '../../../modules/economy/virtualAccountFinance';
import { listDeletedVirtualAccountIds } from '../../../modules/economy/virtualAccountDeletion';
import type { GuildId, NitradoConnId } from '../../../types/scope';

export const economyVirtualAccountTerminalDeletionRouter = Router({ mergeParams: true });

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

async function serializeCustomAccount(guildId: GuildId, connId: NitradoConnId, accountId: string) {
  const account = await getVirtualAccountById(guildId, connId, accountId);
  if (!account || account.kind !== 'CUSTOM') throw new Error('CUSTOM-Konto nicht gefunden.');
  const [finance, metadata, managers, projection] = await Promise.all([
    ensureVirtualAccountFinance(guildId, connId, accountId),
    getVirtualAccountMetadata(guildId, connId, accountId),
    listVirtualAccountManagers(guildId, connId, accountId),
    readProjection(accountId, String(guildId), String(connId)),
  ]);
  const pocketsEmpty = account.balance === 0n && finance.bankBalance === 0n;
  const managedBy = finance.accountPurpose === 'BANK_TREASURY' ? 'SERVER_BANK' : 'VIRTUAL_ACCOUNTS';
  return {
    id: account.id,
    kind: account.kind,
    name: account.name,
    hidden: false,
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
    archiveChannelId: metadata?.archiveChannelId ?? null,
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
    capabilities: {
      managedBy,
      canConfigure: account.status !== 'ARCHIVED',
      canDelete: true,
      canArchive: account.status !== 'ARCHIVED' && pocketsEmpty,
      canPayout: account.status === 'ACTIVE',
      canSyncProjection: account.status !== 'ARCHIVED',
      canRestore: false,
      readOnlyReason: null,
    },
  };
}

// Terminal-deletion list override. It intentionally runs before the Phase-2
// capability router: deleted CUSTOM rows may remain in PostgreSQL for immutable
// FK history, but they are no longer active entities and never reappear here.
economyVirtualAccountTerminalDeletionRouter.get('/control/accounts', requireGuildPermission('economy.view'), async (req, res) => {
  const scope = req.guildScope!;
  const connId = scope.nitradoConnId;
  if (!connId) { res.status(400).json({ error: 'Economy-Gameserver-Scope fehlt.' }); return; }

  const [accounts, deletedIds] = await Promise.all([
    listVirtualAccounts(scope.guildId, connId, true),
    listDeletedVirtualAccountIds({ guildId: scope.guildId, nitradoConnId: connId }),
  ]);
  const activeCustom = accounts.filter(account => account.kind === 'CUSTOM' && !deletedIds.has(account.id));
  res.json({
    accounts: await Promise.all(activeCustom.map(account => serializeCustomAccount(scope.guildId, connId, account.id))),
  });
});

// A delete is final from the control surface. Historical rows can remain only as
// immutable FK targets; they cannot be turned back into active user accounts.
economyVirtualAccountTerminalDeletionRouter.post('/control/accounts/:accountId/restore', requireGuildPermission('economy.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const connId = scope.nitradoConnId;
  if (!connId) { res.status(400).json({ error: 'Economy-Gameserver-Scope fehlt.' }); return; }
  const account = await getVirtualAccountById(scope.guildId, connId, String(req.params.accountId));
  if (!account) { res.status(404).json({ error: 'Virtuelles Konto nicht gefunden.' }); return; }
  if (account.kind !== 'CUSTOM') {
    res.status(400).json({ error: 'Systemkonten werden ausschließlich über ihre Fachfunktion verwaltet.' });
    return;
  }
  res.status(410).json({ error: 'Gelöschte Konten können nicht wiederhergestellt werden.' });
});
