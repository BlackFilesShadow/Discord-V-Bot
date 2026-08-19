import { Router } from 'express';
import { requireGuildPermission } from '../../middleware/auth';
import { tryGetDashboardClient } from '../../clientRegistry';
import {
  archiveVirtualAccount,
  getVirtualAccountById,
  listVirtualAccountEntries,
  listVirtualAccounts,
  transferVirtualAccountToUser,
  type EconomyPocket,
  type VirtualAccountEntryRow,
  type VirtualAccountRow,
} from '../../../modules/economy/virtualAccounts';
import {
  createCustomVirtualAccountWithMetadata,
  getVirtualAccountMetadata,
  getVirtualAccountMetadataMap,
  normalizeVirtualAccountChannelId,
  normalizeVirtualAccountDescription,
  type VirtualAccountMetadata,
} from '../../../modules/economy/virtualAccountMetadata';
import { asUserDiscordId } from '../../../types/scope';
import { logAuditDb } from '../../../utils/logger';

export const economyVirtualAccountsRouter = Router({ mergeParams: true });
const MAX_AMOUNT = 1_000_000_000_000_000n;

type EconomyVirtualRequest = Parameters<Parameters<typeof economyVirtualAccountsRouter.get>[1]>[0];

function scoped(req: EconomyVirtualRequest) {
  const scope = req.guildScope!;
  if (!scope.nitradoConnId) throw new Error('Economy-Gameserver-Scope fehlt.');
  return { scope, connId: scope.nitradoConnId };
}

function serializeAccount(account: VirtualAccountRow, metadata: VirtualAccountMetadata | null = null) {
  return {
    ...account,
    guildId: String(account.guildId),
    nitradoConnId: String(account.nitradoConnId),
    balance: account.balance.toString(),
    description: metadata?.description ?? null,
    channelId: metadata?.channelId ?? null,
  };
}

function serializeEntry(entry: VirtualAccountEntryRow) {
  return {
    ...entry,
    guildId: String(entry.guildId),
    nitradoConnId: String(entry.nitradoConnId),
    delta: entry.delta.toString(),
  };
}

function parseAmount(value: unknown): bigint {
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error('Betrag fehlt.');
  let amount: bigint;
  try { amount = BigInt(value); }
  catch { throw new Error('Betrag ist nicht parsebar.'); }
  if (amount <= 0n || amount > MAX_AMOUNT) throw new Error(`Betrag muss zwischen 1 und ${MAX_AMOUNT.toString()} liegen.`);
  return amount;
}

function parseExpiry(value: unknown): Date | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new Error('expiresAt muss ISO-Datum oder null sein.');
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error('expiresAt ist ungueltig.');
  if (parsed.getTime() <= Date.now()) throw new Error('expiresAt muss in der Zukunft liegen.');
  return parsed;
}

function requestOperationKey(req: EconomyVirtualRequest, prefix: string): string {
  const bodyKey = typeof req.body?.operationId === 'string' ? req.body.operationId : null;
  const raw = bodyKey ?? req.get('X-Idempotency-Key');
  if (!raw || raw.length > 120 || !/^[A-Za-z0-9._:-]+$/.test(raw)) {
    throw new Error('Idempotency-Key fehlt oder ist ungueltig.');
  }
  return `${prefix}:${raw}`;
}

async function validateGuildTextChannel(guildId: string, rawChannelId: unknown): Promise<string | null> {
  const channelId = normalizeVirtualAccountChannelId(rawChannelId);
  if (!channelId) return null;
  const client = tryGetDashboardClient();
  if (!client) throw new Error('Bot nicht bereit; Channel konnte nicht validiert werden.');
  const guild = client.guilds.cache.get(guildId);
  if (!guild) throw new Error('Bot nicht in Guild; Channel konnte nicht validiert werden.');
  const channel = guild.channels.cache.get(channelId) ?? await guild.channels.fetch(channelId).catch(() => null);
  if (!channel || channel.guildId !== guildId || (channel.type !== 0 && channel.type !== 5)) {
    throw new Error('Channel muss ein Text- oder Ankuendigungs-Channel dieser Guild sein.');
  }
  return channelId;
}

async function metadataFor(account: VirtualAccountRow): Promise<VirtualAccountMetadata | null> {
  return getVirtualAccountMetadata(account.guildId, account.nitradoConnId, account.id);
}

economyVirtualAccountsRouter.get('/', requireGuildPermission('economy.view'), async (req, res) => {
  const { scope, connId } = scoped(req);
  const includeArchived = req.query.includeArchived === 'true';
  const [accounts, metadata] = await Promise.all([
    listVirtualAccounts(scope.guildId, connId, includeArchived),
    getVirtualAccountMetadataMap(scope.guildId, connId),
  ]);
  res.json({ nitradoConnId: connId, accounts: accounts.map(account => serializeAccount(account, metadata.get(account.id) ?? null)) });
});

economyVirtualAccountsRouter.post('/', requireGuildPermission('economy.manage'), async (req, res) => {
  const { scope, connId } = scoped(req);
  const body = req.body ?? {};
  if (typeof body.name !== 'string') { res.status(400).json({ error: 'name fehlt.' }); return; }
  if (body.acceptUserTransfers !== undefined && typeof body.acceptUserTransfers !== 'boolean') {
    res.status(400).json({ error: 'acceptUserTransfers muss boolean sein.' }); return;
  }
  let expiresAt: Date | null;
  let description: string | null;
  let channelId: string | null;
  try {
    expiresAt = parseExpiry(body.expiresAt);
    description = normalizeVirtualAccountDescription(body.description);
    channelId = await validateGuildTextChannel(String(scope.guildId), body.channelId);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message }); return;
  }
  try {
    const created = await createCustomVirtualAccountWithMetadata({
      guildId: scope.guildId,
      nitradoConnId: connId,
      name: body.name,
      description,
      channelId,
      expiresAt,
      acceptUserTransfers: body.acceptUserTransfers ?? true,
      createdByDiscordId: asUserDiscordId(scope.actorDiscordId),
    });
    logAuditDb('ECONOMY_VIRTUAL_ACCOUNT_CREATED', 'ECONOMY', {
      actorUserId: req.auth!.userId,
      guildId: scope.guildId,
      details: {
        nitradoConnId: connId,
        accountId: created.account.id,
        name: created.account.name,
        channelId,
        hasDescription: Boolean(description),
        expiresAt,
        acceptUserTransfers: created.account.acceptUserTransfers,
      },
    });
    res.status(201).json(serializeAccount(created.account, created.metadata));
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

economyVirtualAccountsRouter.get('/:accountId', requireGuildPermission('economy.view'), async (req, res) => {
  const { scope, connId } = scoped(req);
  const account = await getVirtualAccountById(scope.guildId, connId, String(req.params.accountId));
  if (!account) { res.status(404).json({ error: 'Virtuelles Konto nicht gefunden.' }); return; }
  res.json(serializeAccount(account, await metadataFor(account)));
});

economyVirtualAccountsRouter.get('/:accountId/entries', requireGuildPermission('economy.view'), async (req, res) => {
  const { scope, connId } = scoped(req);
  const parsedLimit = Number(req.query.limit ?? 50);
  const limit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(100, Math.trunc(parsedLimit))) : 50;
  try {
    const entries = await listVirtualAccountEntries(scope.guildId, connId, String(req.params.accountId), limit);
    res.json({ nitradoConnId: connId, entries: entries.map(serializeEntry) });
  } catch (error) {
    res.status(404).json({ error: (error as Error).message });
  }
});

economyVirtualAccountsRouter.post('/:accountId/archive', requireGuildPermission('economy.manage'), async (req, res) => {
  const { scope, connId } = scoped(req);
  try {
    const account = await archiveVirtualAccount({
      guildId: scope.guildId,
      nitradoConnId: connId,
      accountId: String(req.params.accountId),
      actorDiscordId: asUserDiscordId(scope.actorDiscordId),
    });
    logAuditDb('ECONOMY_VIRTUAL_ACCOUNT_ARCHIVED', 'ECONOMY', {
      actorUserId: req.auth!.userId,
      guildId: scope.guildId,
      details: { nitradoConnId: connId, accountId: account.id, name: account.name },
    });
    res.json(serializeAccount(account, await metadataFor(account)));
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

economyVirtualAccountsRouter.post('/:accountId/payout', requireGuildPermission('economy.manage'), async (req, res) => {
  const { scope, connId } = scoped(req);
  const body = req.body ?? {};
  let targetUserId;
  try { targetUserId = asUserDiscordId(String(body.userDiscordId ?? '')); }
  catch { res.status(400).json({ error: 'userDiscordId ungueltig.' }); return; }
  let amount: bigint;
  try { amount = parseAmount(body.amount); }
  catch (error) { res.status(400).json({ error: (error as Error).message }); return; }
  let targetPocket: EconomyPocket;
  if (body.targetPocket === undefined || body.targetPocket === 'WALLET') targetPocket = 'WALLET';
  else if (body.targetPocket === 'BANK') targetPocket = 'BANK';
  else { res.status(400).json({ error: 'targetPocket muss WALLET oder BANK sein.' }); return; }
  if (body.reason !== undefined && (typeof body.reason !== 'string' || body.reason.trim().length < 3 || body.reason.length > 180)) {
    res.status(400).json({ error: 'reason muss 3..180 Zeichen enthalten.' }); return;
  }
  try {
    const result = await transferVirtualAccountToUser({
      idempotencyKey: requestOperationKey(req, 'dashboard-virtual-payout'),
      guildId: scope.guildId,
      nitradoConnId: connId,
      virtualAccountId: String(req.params.accountId),
      toUserId: targetUserId,
      amount,
      targetPocket,
      actorDiscordId: asUserDiscordId(scope.actorDiscordId),
      reason: body.reason,
      entryType: 'ADMIN_WITHDRAW',
    });
    logAuditDb('ECONOMY_VIRTUAL_ACCOUNT_PAYOUT', 'ECONOMY', {
      actorUserId: req.auth!.userId,
      guildId: scope.guildId,
      details: {
        nitradoConnId: connId,
        accountId: req.params.accountId,
        targetUserId,
        amount: amount.toString(),
        targetPocket,
        booked: result.booked,
      },
    });
    res.json({ ok: true, booked: result.booked, account: serializeAccount(result.account, await metadataFor(result.account)) });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});
