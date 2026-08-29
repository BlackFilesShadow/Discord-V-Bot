import { ChannelType, type GuildMember } from 'discord.js';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import prisma from '../../../database/prisma';
import { requireGuildPermission } from '../../middleware/auth';
import { tryGetDashboardClient } from '../../clientRegistry';
import { asUserDiscordId, type UserDiscordId } from '../../../types/scope';
import { archiveVirtualAccount, getVirtualAccountById, listVirtualAccounts, type VirtualAccountRawDb } from '../../../modules/economy/virtualAccounts';
import { getVirtualAccountMetadata } from '../../../modules/economy/virtualAccountMetadata';
import {
  createConfiguredCustomVirtualAccount,
  updateConfiguredVirtualAccount,
} from '../../../modules/economy/virtualAccountConfiguration';
import {
  ensureBankTreasury,
  ensureVirtualAccountFinance,
  listVirtualAccountManagers,
} from '../../../modules/economy/virtualAccountFinance';
import { deleteUnusedVirtualAccount, listHiddenVirtualAccountIds } from '../../../modules/economy/virtualAccountDeletion';
import { safePayoutVirtualAccountToUser } from '../../../modules/economy/virtualAccountMoneySafety';
import {
  configureVirtualManagerPanelSafe,
  getVirtualManagerPanelSafe,
  refreshConfiguredVirtualManagerPanelSafe,
} from '../../../modules/economy/virtualAccountManagerPanelSafety';
import { retireVirtualAccountProjection, syncVirtualAccountProjection } from '../../../modules/economy/virtualAccountDiscord';
import { logAuditDb } from '../../../utils/logger';

export const economyVirtualAccountControlRouter = Router({ mergeParams: true });

const memberSearchLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: req => req.auth?.discordId ?? req.ip ?? 'anon',
  message: { error: 'Zu viele Member-Suchen. Bitte kurz warten.' },
});

function rawDb(): VirtualAccountRawDb {
  return prisma as unknown as VirtualAccountRawDb;
}

function scoped(req: Parameters<Parameters<typeof economyVirtualAccountControlRouter.get>[1]>[0]) {
  const scope = req.guildScope!;
  if (!scope.nitradoConnId) throw new Error('Economy-Gameserver-Scope fehlt.');
  return { scope, connId: scope.nitradoConnId };
}

function parseExpiry(value: unknown): Date | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new Error('expiresAt muss ISO-Datum oder null sein.');
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) throw new Error('Ablaufzeit muss in der Zukunft liegen.');
  return date;
}

function operationId(body: Record<string, unknown>, headerValue: string | undefined): string {
  const bodyValue = typeof body.operationId === 'string' ? body.operationId.trim() : '';
  const headerKey = typeof headerValue === 'string' ? headerValue.trim() : '';
  const key = bodyValue || headerKey;
  if (!key) throw new Error('operationId oder X-Idempotency-Key ist fuer Geldbuchungen erforderlich.');
  if (!/^[A-Za-z0-9._:-]{1,80}$/.test(key)) throw new Error('operationId ist ungueltig.');
  return key;
}

async function validateNormalTextChannel(guildId: string, raw: unknown): Promise<string | null> {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw !== 'string' || !/^\d{17,20}$/.test(raw.trim())) throw new Error('Channel-ID ist ungueltig.');
  const client = tryGetDashboardClient();
  if (!client) throw new Error('Bot nicht bereit; Channel konnte nicht validiert werden.');
  const guild = client.guilds.cache.get(guildId);
  if (!guild) throw new Error('Bot nicht in Guild.');
  const channel = guild.channels.cache.get(raw.trim()) ?? await guild.channels.fetch(raw.trim()).catch(() => null);
  if (!channel || channel.guildId !== guildId || channel.type !== ChannelType.GuildText) throw new Error('Bitte einen normalen Textkanal dieser Guild auswaehlen.');
  return channel.id;
}

async function validateAccountChannels(guildId: string, body: Record<string, unknown>): Promise<{ channelId: string | null; archiveChannelId: string | null }> {
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

async function readProjection(accountId: string, guildId: string, connId: string) {
  const rows = await rawDb().$queryRawUnsafe<Array<{
    channelId: string | null; messageId: string | null; archiveThreadId: string | null;
    lastSyncedAt: Date | null; lastSyncError: string | null;
  }>>('SELECT "channelId", "messageId", "archiveThreadId", "lastSyncedAt", "lastSyncError" FROM "EconomyVirtualAccountProjection" WHERE "accountId"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 LIMIT 1', accountId, guildId, connId);
  return rows[0] ?? null;
}

async function serializeAccount(guildId: Parameters<typeof ensureVirtualAccountFinance>[0], connId: Parameters<typeof ensureVirtualAccountFinance>[1], accountId: string) {
  const account = await getVirtualAccountById(guildId, connId, accountId);
  if (!account) return null;
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
  };
}

async function bestEffortProjection(req: Parameters<Parameters<typeof economyVirtualAccountControlRouter.post>[1]>[0], accountId: string): Promise<string | null> {
  const { scope, connId } = scoped(req);
  const client = tryGetDashboardClient();
  if (!client) return 'Bot ist nicht bereit; Discord-Projektion wurde noch nicht synchronisiert.';
  try {
    await syncVirtualAccountProjection(client, scope.guildId, connId, accountId);
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

// Neue Control-API. Alte /virtual-accounts-Endpunkte bleiben fuer bestehende
// Clients darunter montiert; kritische Legacy-Archive/Payout-Routen werden
// weiter unten in diesem Router bewusst vor ihnen abgefangen.
economyVirtualAccountControlRouter.get('/control/accounts', requireGuildPermission('economy.view'), async (req, res) => {
  const { scope, connId } = scoped(req);
  const [accounts, hiddenIds] = await Promise.all([
    listVirtualAccounts(scope.guildId, connId, true),
    listHiddenVirtualAccountIds({ guildId: scope.guildId, nitradoConnId: connId }),
  ]);
  const serialized = (await Promise.all(
    accounts.filter(account => !hiddenIds.has(account.id)).map(account => serializeAccount(scope.guildId, connId, account.id)),
  )).filter(Boolean);
  res.json({ accounts: serialized });
});

economyVirtualAccountControlRouter.post('/control/accounts', requireGuildPermission('economy.manage'), async (req, res) => {
  const { scope, connId } = scoped(req);
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (typeof body.name !== 'string') { res.status(400).json({ error: 'name fehlt.' }); return; }
  let channels: { channelId: string | null; archiveChannelId: string | null };
  let managers: UserDiscordId[];
  let expiresAt: Date | null;
  try {
    channels = await validateAccountChannels(String(scope.guildId), body);
    managers = await validateManagers(String(scope.guildId), body.managers);
    expiresAt = parseExpiry(body.expiresAt);
  } catch (error) { res.status(400).json({ error: (error as Error).message }); return; }

  try {
    const created = await createConfiguredCustomVirtualAccount({
      guildId: scope.guildId,
      nitradoConnId: connId,
      name: body.name,
      description: body.description,
      channelId: channels.channelId,
      archiveChannelId: channels.archiveChannelId,
      expiresAt,
      currencyName: body.currencyName,
      currencyEmoji: body.currencyEmoji,
      accountEmoji: body.accountEmoji,
      bannerUrl: body.bannerUrl,
      textStyle: body.textStyle,
      exchangePlayerUnits: body.exchangePlayerUnits,
      exchangeAccountUnits: body.exchangeAccountUnits,
      acceptUserTransfers: body.acceptUserTransfers === undefined ? true : body.acceptUserTransfers,
      managers,
      createdByDiscordId: asUserDiscordId(scope.actorDiscordId),
    });
    const syncWarning = await bestEffortProjection(req, created.account.id);
    const client = tryGetDashboardClient();
    if (client) await refreshConfiguredVirtualManagerPanelSafe(client, scope.guildId, connId, asUserDiscordId(scope.actorDiscordId)).catch(() => undefined);
    logAuditDb('ECONOMY_VIRTUAL_ACCOUNT_CREATED_V2', 'ECONOMY', { actorUserId: req.auth!.userId, guildId: scope.guildId, details: { accountId: created.account.id, nitradoConnId: connId, channelId: channels.channelId, archiveChannelId: channels.archiveChannelId, managers: managers.length } });
    res.status(201).json({ account: await serializeAccount(scope.guildId, connId, created.account.id), syncWarning });
  } catch (error) { res.status(400).json({ error: (error as Error).message }); }
});

economyVirtualAccountControlRouter.put('/control/accounts/:accountId', requireGuildPermission('economy.manage'), async (req, res) => {
  const { scope, connId } = scoped(req);
  const accountId = String(req.params.accountId);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const account = await getVirtualAccountById(scope.guildId, connId, accountId);
  if (!account) { res.status(404).json({ error: 'Virtuelles Konto nicht gefunden.' }); return; }
  try {
    const channels = await validateAccountChannels(String(scope.guildId), body);
    const managers = await validateManagers(String(scope.guildId), body.managers);
    await updateConfiguredVirtualAccount({
      guildId: scope.guildId,
      nitradoConnId: connId,
      accountId,
      description: body.description,
      channelId: channels.channelId,
      archiveChannelId: channels.archiveChannelId,
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
    const syncWarning = await bestEffortProjection(req, accountId);
    const client = tryGetDashboardClient();
    if (client) await refreshConfiguredVirtualManagerPanelSafe(client, scope.guildId, connId, asUserDiscordId(scope.actorDiscordId)).catch(() => undefined);
    logAuditDb('ECONOMY_VIRTUAL_ACCOUNT_UPDATED_V2', 'ECONOMY', { actorUserId: req.auth!.userId, guildId: scope.guildId, details: { accountId, nitradoConnId: connId, channelId: channels.channelId, archiveChannelId: channels.archiveChannelId, managers: managers.length } });
    res.json({ account: await serializeAccount(scope.guildId, connId, accountId), syncWarning });
  } catch (error) { res.status(400).json({ error: (error as Error).message }); }
});

economyVirtualAccountControlRouter.delete('/control/accounts/:accountId', requireGuildPermission('economy.manage'), async (req, res) => {
  const { scope, connId } = scoped(req);
  const accountId = String(req.params.accountId);
  const account = await getVirtualAccountById(scope.guildId, connId, accountId);
  if (!account) { res.status(404).json({ error: 'Virtuelles Konto nicht gefunden.' }); return; }
  try {
    const client = tryGetDashboardClient();
    if (client) await retireVirtualAccountProjection(client, scope.guildId, connId, accountId);
    const deleted = await deleteUnusedVirtualAccount({ guildId: scope.guildId, nitradoConnId: connId, accountId });
    if (client) await refreshConfiguredVirtualManagerPanelSafe(client, scope.guildId, connId, asUserDiscordId(scope.actorDiscordId)).catch(() => undefined);
    logAuditDb('ECONOMY_VIRTUAL_ACCOUNT_DELETED', 'ECONOMY', { actorUserId: req.auth!.userId, guildId: scope.guildId, details: { accountId, accountName: deleted.name, deletionMode: deleted.mode, nitradoConnId: connId } });
    res.json({ ok: true, deleted });
  } catch (error) { res.status(400).json({ error: (error as Error).message }); }
});

economyVirtualAccountControlRouter.post('/control/accounts/:accountId/sync', requireGuildPermission('economy.manage'), async (req, res) => {
  const { scope, connId } = scoped(req);
  const client = tryGetDashboardClient();
  if (!client) { res.status(503).json({ error: 'Bot nicht bereit.' }); return; }
  try {
    await syncVirtualAccountProjection(client, scope.guildId, connId, String(req.params.accountId));
    res.json({ ok: true, account: await serializeAccount(scope.guildId, connId, String(req.params.accountId)) });
  } catch (error) { res.status(502).json({ error: (error as Error).message }); }
});

economyVirtualAccountControlRouter.post('/control/bank-treasury', requireGuildPermission('economy.manage'), async (req, res) => {
  const { scope, connId } = scoped(req);
  try {
    const result = await ensureBankTreasury({ guildId: scope.guildId, nitradoConnId: connId, createdByDiscordId: asUserDiscordId(scope.actorDiscordId) });
    res.json({ account: await serializeAccount(scope.guildId, connId, result.account.id) });
  } catch (error) { res.status(400).json({ error: (error as Error).message }); }
});

economyVirtualAccountControlRouter.get('/control/manager-panel', requireGuildPermission('economy.view'), async (req, res) => {
  const { scope, connId } = scoped(req);
  res.json({ panel: await getVirtualManagerPanelSafe(scope.guildId, connId) });
});

economyVirtualAccountControlRouter.put('/control/manager-panel', requireGuildPermission('economy.manage'), async (req, res) => {
  const { scope, connId } = scoped(req);
  const body = (req.body ?? {}) as Record<string, unknown>;
  let channelId: string | null;
  try { channelId = await validateNormalTextChannel(String(scope.guildId), body.channelId); }
  catch (error) { res.status(400).json({ error: (error as Error).message }); return; }
  if (!channelId) { res.status(400).json({ error: 'Management-Channel ist erforderlich.' }); return; }
  const client = tryGetDashboardClient();
  if (!client) { res.status(503).json({ error: 'Bot nicht bereit.' }); return; }
  try {
    const panel = await configureVirtualManagerPanelSafe(client, { guildId: scope.guildId, nitradoConnId: connId, channelId, updatedByDiscordId: asUserDiscordId(scope.actorDiscordId) });
    res.json({ panel });
  } catch (error) { res.status(502).json({ error: (error as Error).message }); }
});

economyVirtualAccountControlRouter.get('/control/members', memberSearchLimiter, requireGuildPermission('economy.view'), async (req, res) => {
  const { scope } = scoped(req);
  const client = tryGetDashboardClient();
  if (!client) { res.status(503).json({ error: 'Bot nicht bereit.' }); return; }
  const guild = client.guilds.cache.get(String(scope.guildId));
  if (!guild) { res.status(404).json({ error: 'Bot nicht in Guild.' }); return; }
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 64).replace(/[\u0000-\u001f]/g, '') : '';
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 25);
  try {
    const fetched = q ? await guild.members.search({ query: q, limit }) : guild.members.cache.first(limit);
    const members = Array.from(fetched.values?.() ?? fetched) as GuildMember[];
    res.json({ members: members.filter(member => !member.user.bot).map(member => ({
      discordId: member.id,
      username: member.user.username,
      displayName: member.displayName ?? member.user.globalName ?? member.user.username,
      avatar: member.user.avatar ?? null,
    })) });
  } catch (error) { res.status(502).json({ error: 'Discord-Member-Suche fehlgeschlagen.', detail: (error as Error).message }); }
});

// Safety override fuer den bisherigen Archiv-Endpunkt: Wallet UND Bank muessen 0 sein.
economyVirtualAccountControlRouter.post('/:accountId/archive', requireGuildPermission('economy.manage'), async (req, res) => {
  const { scope, connId } = scoped(req);
  const accountId = String(req.params.accountId);
  const account = await getVirtualAccountById(scope.guildId, connId, accountId);
  if (!account) { res.status(404).json({ error: 'Virtuelles Konto nicht gefunden.' }); return; }
  if (account.kind !== 'CUSTOM') { res.status(400).json({ error: 'Systemkonten werden ausschliesslich durch ihre Fachfunktion verwaltet.' }); return; }
  const finance = await ensureVirtualAccountFinance(scope.guildId, connId, accountId);
  if (account.balance !== 0n || finance.bankBalance !== 0n) { res.status(400).json({ error: 'Archivieren ist nur bei Wallet=0 und Bank=0 erlaubt.' }); return; }
  try {
    const archived = await archiveVirtualAccount({ guildId: scope.guildId, nitradoConnId: connId, accountId, actorDiscordId: asUserDiscordId(scope.actorDiscordId) });
    await bestEffortProjection(req, accountId);
    res.json({ ...archived, balance: archived.balance.toString(), bankBalance: finance.bankBalance.toString() });
  } catch (error) { res.status(400).json({ error: (error as Error).message }); }
});

// Safety override fuer den bisherigen Dashboard-Payout. User-GUID bleibt fuer
// Abwaertskompatibilitaet akzeptiert, wird aber unmittelbar vor der Buchung in
// ein aktives menschliches Guild-Mitglied aufgeloest. Auch dieser Fallback nutzt
// dieselbe stabile Idempotenz und denselben Safe-Money-Service wie der vordere
// Safety-Router, damit ein spaeterer Mount-Refactor keine Sicherheitsregression
// erzeugen kann.
economyVirtualAccountControlRouter.post('/:accountId/payout', requireGuildPermission('economy.manage'), async (req, res) => {
  const { scope, connId } = scoped(req);
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
    const member = guild ? (guild.members.cache.get(user.discordId) ?? await guild.members.fetch(user.discordId).catch(() => null)) : null;
    if (!member || member.user.bot) throw new Error('Auszahlungsziel ist kein aktives menschliches Mitglied dieser Guild.');
    const amount = BigInt(String(body.amount ?? '0'));
    if (amount <= 0n) throw new Error('Betrag muss groesser als 0 sein.');
    const sourcePocket = body.sourcePocket === 'BANK' ? 'BANK' : 'WALLET';
    const targetPocket = body.targetPocket === 'BANK' ? 'BANK' : 'WALLET';
    const reason = typeof body.reason === 'string' ? body.reason : 'Dashboard-Auszahlung';
    const result = await safePayoutVirtualAccountToUser({
      idempotencyKey: operationId(body, req.header('x-idempotency-key')),
      guildId: scope.guildId, nitradoConnId: connId, accountId,
      actorDiscordId: asUserDiscordId(scope.actorDiscordId), toUserDiscordId: asUserDiscordId(user.discordId),
      sourcePocket, targetPocket, accountAmount: amount, reason,
    });
    const syncWarning = client ? await bestEffortProjection(req, accountId) : 'Bot nicht bereit; Anzeige nicht synchronisiert.';
    res.json({ ok: true, booked: result.booked, account: await serializeAccount(scope.guildId, connId, accountId), syncWarning });
  } catch (error) { res.status(400).json({ error: (error as Error).message }); }
});
