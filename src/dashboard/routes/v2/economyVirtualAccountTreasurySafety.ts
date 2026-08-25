import { Router } from 'express';
import prisma from '../../../database/prisma';
import { requireGuildPermission } from '../../middleware/auth';
import { tryGetDashboardClient } from '../../clientRegistry';
import { getVirtualAccountById, type EconomyPocket, type VirtualAccountRawDb } from '../../../modules/economy/virtualAccounts';
import { getVirtualAccountMetadata } from '../../../modules/economy/virtualAccountMetadata';
import { ensureVirtualAccountFinance, listVirtualAccountManagers } from '../../../modules/economy/virtualAccountFinance';
import { safePayoutVirtualAccountToUser } from '../../../modules/economy/virtualAccountMoneySafety';
import { ensureBankTreasurySerialized } from '../../../modules/economy/virtualAccountTreasury';
import { syncVirtualAccountProjection } from '../../../modules/economy/virtualAccountDiscord';
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

async function serializeAccount(guildId: NonNullable<Express.Request['guildScope']>['guildId'], connId: NonNullable<Express.Request['guildScope']>['nitradoConnId'], accountId: string) {
  if (!connId) throw new Error('Economy-Gameserver-Scope fehlt.');
  const account = await getVirtualAccountById(guildId, connId, accountId);
  if (!account) throw new Error('Virtuelles Konto nicht gefunden.');
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

function parsePocket(value: unknown, fallback: EconomyPocket, label: string): EconomyPocket {
  if (value === undefined || value === null || value === '') return fallback;
  if (value !== 'WALLET' && value !== 'BANK') throw new Error(`${label} muss WALLET oder BANK sein.`);
  return value;
}

function operationId(body: Record<string, unknown>, fallback: string): string {
  const value = typeof body.operationId === 'string' ? body.operationId.trim() : '';
  const key = value || fallback;
  if (!/^[A-Za-z0-9._:-]{1,80}$/.test(key)) throw new Error('operationId ist ungueltig.');
  return key;
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
    res.json({ account: await serializeAccount(scope.guildId, connId, result.account.id) });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

// Authoritative payout compatibility endpoint. It keeps the historical User DB
// id input, but resolves it to a current human Guild member and then runs the
// hardened CUSTOM-only + replay-matching money service.
economyVirtualAccountTreasurySafetyRouter.post('/:accountId/payout', requireGuildPermission('economy.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const connId = scope.nitradoConnId;
  if (!connId) {
    res.status(400).json({ error: 'Economy-Gameserver-Scope fehlt.' });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const accountId = String(req.params.accountId);
  try {
    const account = await getVirtualAccountById(scope.guildId, connId, accountId);
    if (!account || account.kind !== 'CUSTOM') throw new Error('Nur CUSTOM-Konten duerfen ueber diesen Payout verwaltet werden.');

    const rawUser = typeof body.userId === 'string' ? body.userId.trim() : '';
    const user = await prisma.user.findUnique({ where: { id: rawUser }, select: { discordId: true, status: true } });
    if (!user || user.status !== 'ACTIVE') throw new Error('Auszahlungsziel ist nicht aktiv oder nicht vorhanden.');

    const client = tryGetDashboardClient();
    const guild = client?.guilds.cache.get(String(scope.guildId));
    if (!client || !guild) throw new Error('Discord-Guild ist fuer die Zielpruefung nicht verfuegbar.');
    const member = guild.members.cache.get(user.discordId) ?? await guild.members.fetch(user.discordId).catch(() => null);
    if (!member || member.user.bot) throw new Error('Auszahlungsziel ist kein aktives menschliches Mitglied dieser Guild.');

    let amount: bigint;
    try { amount = BigInt(String(body.amount ?? '0')); } catch { throw new Error('Betrag ist ungueltig.'); }
    if (amount <= 0n) throw new Error('Betrag muss groesser als 0 sein.');
    const sourcePocket = parsePocket(body.sourcePocket, 'WALLET', 'Quelle');
    const targetPocket = parsePocket(body.targetPocket, 'WALLET', 'Ziel');
    const reason = typeof body.reason === 'string' ? body.reason : 'Dashboard-Auszahlung';

    const result = await safePayoutVirtualAccountToUser({
      idempotencyKey: operationId(body, `dashboard-${req.auth!.userId}-${Date.now()}`),
      guildId: scope.guildId,
      nitradoConnId: connId,
      accountId,
      actorDiscordId: asUserDiscordId(scope.actorDiscordId),
      toUserDiscordId: asUserDiscordId(user.discordId),
      sourcePocket,
      targetPocket,
      accountAmount: amount,
      reason,
    });

    let syncWarning: string | null = null;
    try {
      await syncVirtualAccountProjection(client, scope.guildId, connId, accountId);
    } catch (error) {
      syncWarning = (error as Error).message;
    }
    res.json({
      ok: true,
      booked: result.booked,
      account: await serializeAccount(scope.guildId, connId, accountId),
      syncWarning,
    });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});
