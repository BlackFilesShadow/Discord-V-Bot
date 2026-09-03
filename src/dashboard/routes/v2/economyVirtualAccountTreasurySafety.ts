import { ChannelType } from 'discord.js';
import { Router, type NextFunction, type Request, type Response } from 'express';
import prisma from '../../../database/prisma';
import { requireGuildPermission } from '../../middleware/auth';
import { tryGetDashboardClient } from '../../clientRegistry';
import { getVirtualAccountById, listVirtualAccounts, type EconomyPocket, type VirtualAccountRawDb } from '../../../modules/economy/virtualAccounts';
import { getVirtualAccountMetadata } from '../../../modules/economy/virtualAccountMetadata';
import { ensureVirtualAccountFinance, listVirtualAccountManagers } from '../../../modules/economy/virtualAccountFinance';
import { listHiddenVirtualAccountIds } from '../../../modules/economy/virtualAccountDeletion';
import { safePayoutVirtualAccountToUser } from '../../../modules/economy/virtualAccountMoneySafety';
import { ensureBankTreasurySerialized } from '../../../modules/economy/virtualAccountTreasury';
import {
  createConfiguredCustomVirtualAccount,
  updateConfiguredVirtualAccount,
} from '../../../modules/economy/virtualAccountConfiguration';
import { syncVirtualAccountProjectionLive } from '../../../modules/economy/virtualAccountLiveUpdates';
import {
  configureVirtualManagerPanelSafe,
  getVirtualManagerPanelSafe,
  refreshConfiguredVirtualManagerPanelSafe,
} from '../../../modules/economy/virtualAccountManagerPanelSafety';
import { asUserDiscordId, type GuildId, type NitradoConnId, type UserDiscordId } from '../../../types/scope';

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

async function serializeAccount(guildId: GuildId, connId: NitradoConnId, accountId: string, hidden = false) {
  const account = await getVirtualAccountById(guildId, connId, accountId);
  if (!account) throw new Error('Virtuelles Konto nicht gefunden.');
  const [finance, metadata, managers, projection] = await Promise.all([
    ensureVirtualAccountFinance(guildId, connId, accountId),
    getVirtualAccountMetadata(guildId, connId, accountId),
    listVirtualAccountManagers(guildId, connId, accountId),
    readProjection(accountId, String(guildId), String(connId)),
  ]);
  const isCustom = account.kind === 'CUSTOM';
  const managedBy = account.kind === 'LOTTERY_POT'
    ? 'LOTTERY'
    : account.kind === 'MARKET_VENDOR'
      ? 'BLACK_MARKET'
      : finance.accountPurpose === 'BANK_TREASURY'
        ? 'SERVER_BANK'
        : 'VIRTUAL_ACCOUNTS';
  const readOnlyReason = account.kind === 'LOTTERY_POT'
    ? 'Lotterie-Systemkonto: Verwaltung und Lifecycle erfolgen ausschließlich über die Lotterie-Funktion.'
    : account.kind === 'MARKET_VENDOR'
      ? 'Schwarzmarkt-Systemkonto: Verwaltung und Lifecycle erfolgen ausschließlich über die Schwarzmarkt-Funktion.'
      : hidden
        ? 'Dieses CUSTOM-Konto ist aus der allgemeinen Kontenverwaltung ausgeblendet.'
        : null;
  return {
    id: account.id,
    kind: account.kind,
    name: account.name,
    hidden,
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
      canConfigure: isCustom && !hidden && account.status !== 'ARCHIVED',
      canDelete: isCustom && !hidden,
      canArchive: false,
      canPayout: isCustom && !hidden && account.status === 'ACTIVE',
      canSyncProjection: isCustom && !hidden && account.status !== 'ARCHIVED',
      canRestore: isCustom && hidden,
      readOnlyReason,
    },
  };
}

function parsePocket(value: unknown, fallback: EconomyPocket, label: string): EconomyPocket {
  if (value === undefined || value === null || value === '') return fallback;
  if (value !== 'WALLET' && value !== 'BANK') throw new Error(`${label} muss WALLET oder BANK sein.`);
  return value;
}

function operationId(body: Record<string, unknown>, headerValue: string | undefined): string {
  const bodyValue = typeof body.operationId === 'string' ? body.operationId.trim() : '';
  const headerKey = typeof headerValue === 'string' ? headerValue.trim() : '';
  const key = bodyValue || headerKey;
  if (!key) throw new Error('operationId oder X-Idempotency-Key ist fuer Geldbuchungen erforderlich.');
  if (!/^[A-Za-z0-9._:-]{1,80}$/.test(key)) throw new Error('operationId ist ungueltig.');
  return key;
}

function parseExpiry(value: unknown): Date | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new Error('expiresAt muss ISO-Datum oder null sein.');
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) throw new Error('Ablaufzeit muss in der Zukunft liegen.');
  return date;
}

async function validateNormalTextChannel(guildId: string, raw: unknown): Promise<string | null> {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw !== 'string' || !/^\d{17,20}$/.test(raw.trim())) throw new Error('Channel-ID ist ungueltig.');
  const client = tryGetDashboardClient();
  if (!client) throw new Error('Bot nicht bereit; Channel konnte nicht validiert werden.');
  const guild = client.guilds.cache.get(guildId);
  if (!guild) throw new Error('Bot nicht in Guild.');
  const channel = guild.channels.cache.get(raw.trim()) ?? await guild.channels.fetch(raw.trim()).catch(() => null);
  if (!channel || channel.guildId !== guildId || channel.type !== ChannelType.GuildText) {
    throw new Error('Bitte einen normalen Textkanal dieser Guild auswaehlen.');
  }
  return channel.id;
}

async function validateAccountChannels(
  guildId: string,
  body: Record<string, unknown>,
): Promise<{ channelId: string | null; archiveChannelId: string | null }> {
  const [channelId, archiveChannelId] = await Promise.all([
    validateNormalTextChannel(guildId, body.channelId),
    validateNormalTextChannel(guildId, body.archiveChannelId),
  ]);
  if (!channelId && archiveChannelId) throw new Error('Ein Archiv-Kanal ist nur zusammen mit einem Hauptkanal zulaessig.');
  if (channelId && !archiveChannelId) throw new Error('Fuer eine Discord-Integration ist ein separater Archiv-Kanal erforderlich.');
  if (channelId && archiveChannelId && channelId === archiveChannelId) throw new Error('Hauptkanal und Archiv-Kanal muessen getrennte Kanaele sein.');
  return { channelId, archiveChannelId };
}

async function validateManagers(guildId: string, raw: unknown): Promise<UserDiscordId[]> {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > 25) throw new Error('managers muss eine Liste mit maximal 25 Discord-IDs sein.');
  const ids = [...new Set(raw.map(value => String(value).trim()))];
  const client = tryGetDashboardClient();
  if (!client) throw new Error('Bot nicht bereit; Kontoverwalter konnten nicht validiert werden.');
  const guild = client.guilds.cache.get(guildId);
  if (!guild) throw new Error('Bot nicht in Guild.');
  const valid: UserDiscordId[] = [];
  for (const id of ids) {
    if (!/^\d{17,20}$/.test(id)) throw new Error('Ungueltige Discord-ID in Kontoverwaltern.');
    const member = guild.members.cache.get(id) ?? await guild.members.fetch(id).catch(() => null);
    if (!member || member.user.bot) throw new Error(`Kontoverwalter ${id} ist kein aktives menschliches Guild-Mitglied.`);
    valid.push(asUserDiscordId(id));
  }
  return valid;
}

async function syncConfiguration(guildId: GuildId, connId: NitradoConnId, accountId: string, actor: UserDiscordId): Promise<string | null> {
  const client = tryGetDashboardClient();
  if (!client) return 'Bot ist nicht bereit; Discord-Projektion wurde noch nicht synchronisiert.';
  const warnings: string[] = [];
  try {
    await syncVirtualAccountProjectionLive(client, guildId, connId, accountId);
  } catch (error) {
    warnings.push(`Konto-Embed: ${(error as Error).message}`);
  }
  try {
    await refreshConfiguredVirtualManagerPanelSafe(client, guildId, connId, actor);
  } catch (error) {
    warnings.push(`Manager-Panel: ${(error as Error).message}`);
  }
  return warnings.length > 0 ? warnings.join(' | ') : null;
}

async function requireCustomControlAccount(req: Request, res: Response, next: NextFunction): Promise<void> {
  const scope = req.guildScope!;
  const connId = scope.nitradoConnId;
  if (!connId) { res.status(400).json({ error: 'Economy-Gameserver-Scope fehlt.' }); return; }
  const account = await getVirtualAccountById(scope.guildId, connId, String(req.params.accountId));
  if (!account) { res.status(404).json({ error: 'Virtuelles Konto nicht gefunden.' }); return; }
  if (account.kind !== 'CUSTOM') {
    res.status(400).json({ error: 'Systemkonten werden ausschließlich über ihre Fachfunktion verwaltet.' });
    return;
  }
  next();
}

// Authoritative capability registry before the general control router. The
// legacy control panel receives CUSTOM accounts only; domain-owned system
// accounts are exposed separately and read-only in the shared workspace.
economyVirtualAccountTreasurySafetyRouter.get('/control/accounts', requireGuildPermission('economy.view'), async (req, res) => {
  const scope = req.guildScope!;
  const connId = scope.nitradoConnId;
  if (!connId) { res.status(400).json({ error: 'Economy-Gameserver-Scope fehlt.' }); return; }
  const [accounts, hiddenIds] = await Promise.all([
    listVirtualAccounts(scope.guildId, connId, true),
    listHiddenVirtualAccountIds({ guildId: scope.guildId, nitradoConnId: connId }),
  ]);
  const customAccounts = accounts.filter(account => account.kind === 'CUSTOM');
  res.json({
    accounts: await Promise.all(customAccounts.map(account => serializeAccount(scope.guildId, connId, account.id, hiddenIds.has(account.id)))),
  });
});

economyVirtualAccountTreasurySafetyRouter.get('/control/system-accounts', requireGuildPermission('economy.view'), async (req, res) => {
  const scope = req.guildScope!;
  const connId = scope.nitradoConnId;
  if (!connId) { res.status(400).json({ error: 'Economy-Gameserver-Scope fehlt.' }); return; }
  const [accounts, hiddenIds] = await Promise.all([
    listVirtualAccounts(scope.guildId, connId, true),
    listHiddenVirtualAccountIds({ guildId: scope.guildId, nitradoConnId: connId }),
  ]);
  const systemAccounts = accounts.filter(account => account.kind !== 'CUSTOM');
  res.json({
    accounts: await Promise.all(systemAccounts.map(account => serializeAccount(scope.guildId, connId, account.id, hiddenIds.has(account.id)))),
  });
});

// System accounts never fall through to generic control-surface mutations.
economyVirtualAccountTreasurySafetyRouter.delete('/control/accounts/:accountId', requireGuildPermission('economy.manage'), requireCustomControlAccount);
economyVirtualAccountTreasurySafetyRouter.post('/control/accounts/:accountId/restore', requireGuildPermission('economy.manage'), requireCustomControlAccount);
economyVirtualAccountTreasurySafetyRouter.post('/control/accounts/:accountId/sync', requireGuildPermission('economy.manage'), requireCustomControlAccount);

// Authoritative atomic CREATE before the general control router.
economyVirtualAccountTreasurySafetyRouter.post('/control/accounts', requireGuildPermission('economy.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const connId = scope.nitradoConnId;
  if (!connId) { res.status(400).json({ error: 'Economy-Gameserver-Scope fehlt.' }); return; }
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (typeof body.name !== 'string') { res.status(400).json({ error: 'name fehlt.' }); return; }
  try {
    const { channelId, archiveChannelId } = await validateAccountChannels(String(scope.guildId), body);
    const managers = await validateManagers(String(scope.guildId), body.managers);
    const created = await createConfiguredCustomVirtualAccount({
      guildId: scope.guildId,
      nitradoConnId: connId,
      name: body.name,
      description: body.description,
      channelId,
      archiveChannelId,
      expiresAt: parseExpiry(body.expiresAt),
      currencyName: body.currencyName,
      currencyEmoji: body.currencyEmoji,
      accountEmoji: body.accountEmoji,
      bannerUrl: body.bannerUrl,
      textStyle: body.textStyle,
      exchangePlayerUnits: body.exchangePlayerUnits,
      exchangeAccountUnits: body.exchangeAccountUnits,
      acceptUserTransfers: body.acceptUserTransfers,
      managers,
      createdByDiscordId: asUserDiscordId(scope.actorDiscordId),
    });
    const syncWarning = await syncConfiguration(scope.guildId, connId, created.account.id, asUserDiscordId(scope.actorDiscordId));
    res.status(201).json({ account: await serializeAccount(scope.guildId, connId, created.account.id), syncWarning });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

// Authoritative atomic configuration UPDATE before the general control router.
economyVirtualAccountTreasurySafetyRouter.put('/control/accounts/:accountId', requireGuildPermission('economy.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const connId = scope.nitradoConnId;
  if (!connId) { res.status(400).json({ error: 'Economy-Gameserver-Scope fehlt.' }); return; }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const accountId = String(req.params.accountId);
  try {
    const account = await getVirtualAccountById(scope.guildId, connId, accountId);
    if (!account) { res.status(404).json({ error: 'Virtuelles Konto nicht gefunden.' }); return; }
    if (account.kind !== 'CUSTOM') {
      res.status(400).json({ error: 'Systemkonten werden ausschließlich über ihre Fachfunktion verwaltet.' });
      return;
    }
    const { channelId, archiveChannelId } = await validateAccountChannels(String(scope.guildId), body);
    const managers = await validateManagers(String(scope.guildId), body.managers);
    await updateConfiguredVirtualAccount({
      guildId: scope.guildId,
      nitradoConnId: connId,
      accountId,
      description: body.description,
      channelId,
      archiveChannelId,
      currencyName: body.currencyName,
      currencyEmoji: body.currencyEmoji,
      accountEmoji: body.accountEmoji,
      bannerUrl: body.bannerUrl,
      textStyle: body.textStyle,
      exchangePlayerUnits: body.exchangePlayerUnits,
      exchangeAccountUnits: body.exchangeAccountUnits,
      acceptUserTransfers: body.acceptUserTransfers,
      managers,
      updatedByDiscordId: asUserDiscordId(scope.actorDiscordId),
    });
    const syncWarning = await syncConfiguration(scope.guildId, connId, accountId, asUserDiscordId(scope.actorDiscordId));
    res.json({ account: await serializeAccount(scope.guildId, connId, accountId), syncWarning });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

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

// Retry-safe roleless manager panel. These handlers intentionally shadow the
// compatibility handlers in economyVirtualAccountControlRouter mounted after us.
economyVirtualAccountTreasurySafetyRouter.get('/control/manager-panel', requireGuildPermission('economy.view'), async (req, res) => {
  const scope = req.guildScope!;
  const connId = scope.nitradoConnId;
  if (!connId) { res.status(400).json({ error: 'Economy-Gameserver-Scope fehlt.' }); return; }
  res.json({ panel: await getVirtualManagerPanelSafe(scope.guildId, connId) });
});

economyVirtualAccountTreasurySafetyRouter.put('/control/manager-panel', requireGuildPermission('economy.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const connId = scope.nitradoConnId;
  if (!connId) { res.status(400).json({ error: 'Economy-Gameserver-Scope fehlt.' }); return; }
  const body = (req.body ?? {}) as Record<string, unknown>;
  try {
    const channelId = await validateNormalTextChannel(String(scope.guildId), body.channelId);
    if (!channelId) throw new Error('Management-Channel ist erforderlich.');
    const client = tryGetDashboardClient();
    if (!client) { res.status(503).json({ error: 'Bot nicht bereit.' }); return; }
    const panel = await configureVirtualManagerPanelSafe(client, {
      guildId: scope.guildId,
      nitradoConnId: connId,
      channelId,
      updatedByDiscordId: asUserDiscordId(scope.actorDiscordId),
    });
    res.json({ panel });
  } catch (error) {
    res.status(502).json({ error: (error as Error).message });
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
      idempotencyKey: operationId(body, req.header('x-idempotency-key')),
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
      await syncVirtualAccountProjectionLive(client, scope.guildId, connId, accountId);
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
