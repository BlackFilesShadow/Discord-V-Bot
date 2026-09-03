import { Router, type NextFunction, type Request, type Response } from 'express';
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

async function isTerminallyDeleted(guildId: GuildId, connId: NitradoConnId, accountId: string): Promise<boolean> {
  const rows = await rawDb().$queryRawUnsafe<Array<{ deleted: boolean }>>(
    'SELECT EXISTS(SELECT 1 FROM "EconomyVirtualAccountHistoryIdentity" WHERE "accountId"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 AND "deletedAt" IS NOT NULL) AS deleted',
    accountId,
    String(guildId),
    String(connId),
  );
  return Boolean(rows[0]?.deleted);
}

async function domainOwner(guildId: GuildId, connId: NitradoConnId, accountId: string): Promise<'LOTTERY' | 'BLACK_MARKET' | 'SERVER_BANK' | 'VIRTUAL_ACCOUNTS' | null> {
  const account = await getVirtualAccountById(guildId, connId, accountId);
  if (!account) return null;
  if (account.kind === 'LOTTERY_POT') return 'LOTTERY';
  if (account.kind === 'MARKET_VENDOR') return 'BLACK_MARKET';
  const finance = await ensureVirtualAccountFinance(guildId, connId, accountId);
  return finance.accountPurpose === 'BANK_TREASURY' ? 'SERVER_BANK' : 'VIRTUAL_ACCOUNTS';
}

async function rejectDeletedOrDomainOwnedMutation(req: Request, res: Response, next: NextFunction): Promise<void> {
  const scope = req.guildScope!;
  const connId = scope.nitradoConnId;
  if (!connId) { res.status(400).json({ error: 'Economy-Gameserver-Scope fehlt.' }); return; }
  const accountId = String(req.params.accountId);
  if (await isTerminallyDeleted(scope.guildId, connId, accountId)) {
    res.status(410).json({ error: 'Dieses Konto wurde dauerhaft gelöscht und kann nicht mehr verändert werden.' });
    return;
  }
  const owner = await domainOwner(scope.guildId, connId, accountId);
  if (owner && owner !== 'VIRTUAL_ACCOUNTS') {
    const label = owner === 'SERVER_BANK' ? 'Serverbank' : owner === 'LOTTERY' ? 'Lotterie' : 'Schwarzmarkt';
    res.status(400).json({ error: `${label}-Systemkonten werden ausschließlich über ihre Fachfunktion verwaltet.` });
    return;
  }
  next();
}

async function serializeAccount(guildId: GuildId, connId: NitradoConnId, accountId: string) {
  const account = await getVirtualAccountById(guildId, connId, accountId);
  if (!account) throw new Error('Virtuelles Konto nicht gefunden.');
  const [finance, metadata, managers, projection] = await Promise.all([
    ensureVirtualAccountFinance(guildId, connId, accountId),
    getVirtualAccountMetadata(guildId, connId, accountId),
    listVirtualAccountManagers(guildId, connId, accountId),
    readProjection(accountId, String(guildId), String(connId)),
  ]);
  const pocketsEmpty = account.balance === 0n && finance.bankBalance === 0n;
  const managedBy = account.kind === 'LOTTERY_POT'
    ? 'LOTTERY'
    : account.kind === 'MARKET_VENDOR'
      ? 'BLACK_MARKET'
      : finance.accountPurpose === 'BANK_TREASURY'
        ? 'SERVER_BANK'
        : 'VIRTUAL_ACCOUNTS';
  const genericOwned = managedBy === 'VIRTUAL_ACCOUNTS';
  const readOnlyReason = managedBy === 'LOTTERY'
    ? 'Lotterie-Systemkonto: Verwaltung und Lifecycle erfolgen ausschließlich über die Lotterie-Funktion.'
    : managedBy === 'BLACK_MARKET'
      ? 'Schwarzmarkt-Systemkonto: Verwaltung und Lifecycle erfolgen ausschließlich über die Schwarzmarkt-Funktion.'
      : managedBy === 'SERVER_BANK'
        ? 'Serverbank-Systemkonto: Verwaltung und Lifecycle erfolgen ausschließlich über die Serverbank-Funktion.'
        : null;
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
      canConfigure: genericOwned && account.status !== 'ARCHIVED',
      canDelete: genericOwned,
      canArchive: genericOwned && account.status !== 'ARCHIVED' && pocketsEmpty,
      canPayout: genericOwned && account.status === 'ACTIVE',
      canSyncProjection: genericOwned && account.status !== 'ARCHIVED',
      canRestore: false,
      readOnlyReason,
    },
  };
}

// Generic control list contains only accounts owned by the generic virtual-account
// feature. The Serverbank is CUSTOM-backed but domain-owned and therefore excluded.
economyVirtualAccountTerminalDeletionRouter.get('/control/accounts', requireGuildPermission('economy.view'), async (req, res) => {
  const scope = req.guildScope!;
  const connId = scope.nitradoConnId;
  if (!connId) { res.status(400).json({ error: 'Economy-Gameserver-Scope fehlt.' }); return; }

  const [accounts, deletedIds] = await Promise.all([
    listVirtualAccounts(scope.guildId, connId, true),
    listDeletedVirtualAccountIds({ guildId: scope.guildId, nitradoConnId: connId }),
  ]);
  const liveAccounts = accounts.filter(account => !deletedIds.has(account.id));
  const serialized = await Promise.all(liveAccounts.map(account => serializeAccount(scope.guildId, connId, account.id)));
  res.json({ accounts: serialized.filter(account => account.capabilities.managedBy === 'VIRTUAL_ACCOUNTS') });
});

// Read-only registry includes every domain-owned account, including the CUSTOM-
// backed Serverbank, so domain ownership is visible instead of silently falling
// into the generic CUSTOM workspace.
economyVirtualAccountTerminalDeletionRouter.get('/control/system-accounts', requireGuildPermission('economy.view'), async (req, res) => {
  const scope = req.guildScope!;
  const connId = scope.nitradoConnId;
  if (!connId) { res.status(400).json({ error: 'Economy-Gameserver-Scope fehlt.' }); return; }

  const [accounts, deletedIds] = await Promise.all([
    listVirtualAccounts(scope.guildId, connId, true),
    listDeletedVirtualAccountIds({ guildId: scope.guildId, nitradoConnId: connId }),
  ]);
  const liveAccounts = accounts.filter(account => !deletedIds.has(account.id));
  const serialized = await Promise.all(liveAccounts.map(account => serializeAccount(scope.guildId, connId, account.id)));
  res.json({ accounts: serialized.filter(account => account.capabilities.managedBy !== 'VIRTUAL_ACCOUNTS') });
});

// Old IDs remain terminal through the historical identity even though the live
// account row is physically absent. Domain-owned live accounts fail closed too.
economyVirtualAccountTerminalDeletionRouter.put('/control/accounts/:accountId', requireGuildPermission('economy.manage'), rejectDeletedOrDomainOwnedMutation);
economyVirtualAccountTerminalDeletionRouter.delete('/control/accounts/:accountId', requireGuildPermission('economy.manage'), rejectDeletedOrDomainOwnedMutation);
economyVirtualAccountTerminalDeletionRouter.post('/control/accounts/:accountId/sync', requireGuildPermission('economy.manage'), rejectDeletedOrDomainOwnedMutation);
economyVirtualAccountTerminalDeletionRouter.post('/:accountId/archive', requireGuildPermission('economy.manage'), rejectDeletedOrDomainOwnedMutation);
economyVirtualAccountTerminalDeletionRouter.post('/:accountId/payout', requireGuildPermission('economy.manage'), rejectDeletedOrDomainOwnedMutation);

economyVirtualAccountTerminalDeletionRouter.post('/control/accounts/:accountId/restore', requireGuildPermission('economy.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const connId = scope.nitradoConnId;
  if (!connId) { res.status(400).json({ error: 'Economy-Gameserver-Scope fehlt.' }); return; }
  const accountId = String(req.params.accountId);
  if (await isTerminallyDeleted(scope.guildId, connId, accountId)) {
    res.status(410).json({ error: 'Gelöschte Konten können nicht wiederhergestellt werden.' });
    return;
  }
  const owner = await domainOwner(scope.guildId, connId, accountId);
  if (!owner) { res.status(404).json({ error: 'Virtuelles Konto nicht gefunden.' }); return; }
  if (owner !== 'VIRTUAL_ACCOUNTS') {
    const label = owner === 'SERVER_BANK' ? 'Serverbank' : owner === 'LOTTERY' ? 'Lotterie' : 'Schwarzmarkt';
    res.status(400).json({ error: `${label}-Systemkonten werden ausschließlich über ihre Fachfunktion verwaltet.` });
    return;
  }
  res.status(400).json({ error: 'Dieses Konto ist nicht gelöscht.' });
});
