/**
 * Economy: Config + Accounts + Transactions — immer Guild+Gameserver-gescopt.
 * Der vorgeschaltete requireSafeDashboardEconomyScope setzt
 * req.guildScope.nitradoConnId nach Guild/Slot/Status-Pruefung.
 *
 * Kanonische Aktivierung ist ServerSettings.economyActive. Die historischen
 * EconomyConfig.enabled/EconomySlotConfig.enabled werden kompatibel synchron
 * gehalten, sind aber keine zweite Dashboard-Wahrheit mehr.
 */
import { Router } from 'express';
import prisma from '../../../database/prisma';
import { requireGuildPermission } from '../../middleware/auth';
import {
  getConfig, getAccountOrZero, recentTransactions,
} from '../../../modules/economy/repository';
import { applyDashboardAdminPay } from '../../../modules/economy/dashboardAdminPay';
import { asUserDiscordId } from '../../../types/scope';
import { logAuditDb } from '../../../utils/logger';
import { emitGuildEvent } from '../../socket/emitter';

export const economyRouter = Router({ mergeParams: true });
const ECONOMY_DELTA_MAX = 1_000_000_000_000_000n;
const ECONOMY_DELTA_MIN = -ECONOMY_DELTA_MAX;

type RawDb = { $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T> };
const rawDb = prisma as unknown as RawDb;

function scoped(req: Parameters<Parameters<typeof economyRouter.get>[1]>[0]) {
  const scope = req.guildScope!;
  if (!scope.nitradoConnId) throw new Error('Economy-Gameserver-Scope fehlt.');
  return { scope, connId: scope.nitradoConnId };
}

async function economyEnabled(guildId: string, nitradoConnId: string): Promise<boolean> {
  const settings = await prisma.serverSettings.findUnique({
    where: { guildId_nitradoConnId: { guildId, nitradoConnId } },
    select: { economyActive: true },
  });
  return settings?.economyActive ?? false;
}

function configPayload(connId: string, cfg: Awaited<ReturnType<typeof getConfig>>, enabled: boolean) {
  return {
    nitradoConnId: connId,
    currencyName: cfg.currencyName,
    emoji: cfg.emoji,
    enabled,
    startBalance: cfg.startBalance,
    playtimeRewardPercent: cfg.playtimeRewardPercent,
    bankInterestPercent: cfg.bankInterestPercent,
    bankChannelId: cfg.bankChannelId,
  };
}

economyRouter.get('/config', requireGuildPermission('economy.view'), async (req, res) => {
  const { scope, connId } = scoped(req);
  const [cfg, enabled] = await Promise.all([
    getConfig(scope.guildId, connId),
    economyEnabled(scope.guildId, connId),
  ]);
  res.json(configPayload(connId, cfg, enabled));
});

economyRouter.put('/config', requireGuildPermission('economy.manage'), async (req, res) => {
  const { scope, connId } = scoped(req);
  const b = req.body ?? {};
  const current = await getConfig(scope.guildId, connId);
  const currentEnabled = await economyEnabled(scope.guildId, connId);

  const patch: Record<string, unknown> = {};
  if (typeof b.currencyName === 'string' && b.currencyName.length >= 1 && b.currencyName.length <= 40) patch.currencyName = b.currencyName;
  if (typeof b.emoji === 'string' && b.emoji.length >= 1 && b.emoji.length <= 40) patch.emoji = b.emoji;
  if (typeof b.enabled === 'boolean') patch.enabled = b.enabled;
  if (typeof b.startBalance === 'number' && Number.isInteger(b.startBalance) && b.startBalance >= 0 && b.startBalance <= 1_000_000_000) patch.startBalance = b.startBalance;
  if (typeof b.playtimeRewardPercent === 'number' && Number.isInteger(b.playtimeRewardPercent) && b.playtimeRewardPercent >= 0 && b.playtimeRewardPercent <= 1000) patch.playtimeRewardPercent = b.playtimeRewardPercent;
  if (typeof b.bankInterestPercent === 'number' && Number.isInteger(b.bankInterestPercent) && b.bankInterestPercent >= 0 && b.bankInterestPercent <= 100) patch.bankInterestPercent = b.bankInterestPercent;
  if (b.bankChannelId === null || (typeof b.bankChannelId === 'string' && /^\d{17,20}$/.test(b.bankChannelId))) patch.bankChannelId = b.bankChannelId;
  if (Object.keys(patch).length === 0) {
    res.status(400).json({ error: 'Keine gueltigen Economy-Felder.' });
    return;
  }

  const merged = {
    currencyName: (patch.currencyName as string | undefined) ?? current.currencyName,
    emoji: (patch.emoji as string | undefined) ?? current.emoji,
    enabled: (patch.enabled as boolean | undefined) ?? currentEnabled,
    startBalance: (patch.startBalance as number | undefined) ?? current.startBalance,
    playtimeRewardPercent: (patch.playtimeRewardPercent as number | undefined) ?? current.playtimeRewardPercent,
    bankInterestPercent: (patch.bankInterestPercent as number | undefined) ?? current.bankInterestPercent,
    bankChannelId: Object.prototype.hasOwnProperty.call(patch, 'bankChannelId')
      ? (patch.bankChannelId as string | null)
      : current.bankChannelId,
  };

  await prisma.$transaction(async tx => {
    await tx.economyConfig.upsert({
      where: { guildServer: { guildId: scope.guildId, nitradoConnId: connId } },
      create: {
        guildId: scope.guildId,
        nitradoConnId: connId,
        currencyName: merged.currencyName,
        emoji: merged.emoji,
        enabled: merged.enabled,
        startBalance: merged.startBalance,
        playtimeRewardPercent: merged.playtimeRewardPercent,
        bankInterestPercent: merged.bankInterestPercent,
        bankChannelId: merged.bankChannelId,
      },
      update: {
        currencyName: merged.currencyName,
        emoji: merged.emoji,
        enabled: merged.enabled,
        startBalance: merged.startBalance,
        playtimeRewardPercent: merged.playtimeRewardPercent,
        bankInterestPercent: merged.bankInterestPercent,
        bankChannelId: merged.bankChannelId,
      },
    });
    await tx.serverSettings.upsert({
      where: { guildId_nitradoConnId: { guildId: scope.guildId, nitradoConnId: connId } },
      create: { guildId: scope.guildId, nitradoConnId: connId, economyActive: merged.enabled },
      update: { economyActive: merged.enabled },
    });
    await tx.economySlotConfig.upsert({
      where: { guildId_nitradoConnId: { guildId: scope.guildId, nitradoConnId: connId } },
      create: { guildId: scope.guildId, nitradoConnId: connId, enabled: merged.enabled },
      update: { enabled: merged.enabled },
    });
  });

  const cfg = await getConfig(scope.guildId, connId);
  logAuditDb('ECONOMY_CONFIG_UPDATED', 'ECONOMY', {
    actorUserId: req.auth!.userId,
    guildId: scope.guildId,
    details: { nitradoConnId: connId, fields: Object.keys(patch), canonicalActivation: 'ServerSettings.economyActive' },
  });
  emitGuildEvent(scope.guildId, { type: 'settings.changed', payload: { guildId: scope.guildId, slotId: connId } });
  res.json(configPayload(connId, cfg, merged.enabled));
});

economyRouter.get('/accounts/:userDiscordId', requireGuildPermission('economy.view'), async (req, res) => {
  const { scope, connId } = scoped(req);
  let userId;
  try { userId = asUserDiscordId(String(req.params.userDiscordId)); }
  catch { res.status(400).json({ error: 'userDiscordId ungueltig.' }); return; }
  const acc = await getAccountOrZero(scope.guildId, connId, userId);
  const tx = await recentTransactions(scope.guildId, connId, userId, 20);
  res.json({
    nitradoConnId: connId,
    userDiscordId: acc.userDiscordId,
    walletBalance: acc.walletBalance.toString(),
    bankBalance: acc.bankBalance.toString(),
    lifetimeEarned: acc.lifetimeEarned.toString(),
    lifetimeSpent: acc.lifetimeSpent.toString(),
    recentTransactions: tx.map(t => ({ id: t.id, delta: t.delta.toString(), type: t.type, reason: t.reason, createdAt: t.createdAt })),
  });
});

economyRouter.post('/accounts/:userDiscordId/admin-pay', requireGuildPermission('economy.manage'), async (req, res) => {
  const { scope, connId } = scoped(req);
  let target;
  try { target = asUserDiscordId(String(req.params.userDiscordId)); }
  catch { res.status(400).json({ error: 'userDiscordId ungueltig.' }); return; }
  const { delta, reason } = req.body ?? {};
  if (typeof delta !== 'string' && typeof delta !== 'number') { res.status(400).json({ error: 'delta muss string oder number sein.' }); return; }
  let bigDelta: bigint;
  try { bigDelta = BigInt(delta as string | number); }
  catch { res.status(400).json({ error: 'delta nicht parsebar.' }); return; }
  if (bigDelta === 0n) { res.status(400).json({ error: 'delta darf nicht 0 sein.' }); return; }
  if (bigDelta > ECONOMY_DELTA_MAX || bigDelta < ECONOMY_DELTA_MIN) {
    res.status(400).json({ error: `delta ausserhalb des erlaubten Bereichs (±${ECONOMY_DELTA_MAX.toString()}).` });
    return;
  }
  if (typeof reason !== 'string' || reason.length < 3 || reason.length > 200) { res.status(400).json({ error: 'reason 3..200 Zeichen.' }); return; }
  const httpIdempotencyKey = req.header('x-idempotency-key');
  if (!httpIdempotencyKey || httpIdempotencyKey.trim().length < 8 || httpIdempotencyKey.trim().length > 128) {
    res.status(400).json({ error: 'X-Idempotency-Key 8..128 Zeichen ist fuer Admin-Auszahlungen erforderlich.' });
    return;
  }

  try {
    const result = await applyDashboardAdminPay({
      httpIdempotencyKey,
      guildId: scope.guildId,
      nitradoConnId: connId,
      targetUserId: target,
      delta: bigDelta,
      reason,
      actorDiscordId: asUserDiscordId(scope.actorDiscordId),
    });
    if (result.applied) {
      logAuditDb('ECONOMY_ADMIN_PAY', 'ECONOMY', {
        actorUserId: req.auth!.userId,
        guildId: scope.guildId,
        details: { nitradoConnId: connId, target, delta: bigDelta.toString(), reason },
      });
    }
    res.json({ ok: true, applied: result.applied, nitradoConnId: connId });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

interface OverviewAggregate { wallet: bigint | null; bank: bigint | null; count: bigint }
interface OverviewTx { id: string; userDiscordId: string; delta: bigint; type: string; reason: string | null; createdAt: Date }
interface OverviewCasinoRound { bet: bigint; payout: bigint; type: string }
interface OverviewCasinoGame { type: string; enabled: boolean }

/** GET /overview — ausschliesslich fuer den validierten Gameserver. */
economyRouter.get('/overview', requireGuildPermission('economy.view'), async (req, res) => {
  const { scope, connId } = scoped(req);
  const guildId = scope.guildId;
  const [cfg, enabled, accountAggRows, linkCountRows, txCountRows, recentTx, casinoRounds, casinoGames] = await Promise.all([
    getConfig(guildId, connId),
    economyEnabled(guildId, connId),
    rawDb.$queryRawUnsafe<OverviewAggregate[]>(
      'SELECT COALESCE(SUM("walletBalance"),0) AS wallet, COALESCE(SUM("bankBalance"),0) AS bank, COUNT(*)::bigint AS count FROM "EconomyAccount" WHERE "guildId"=$1 AND "nitradoConnId"=$2',
      String(guildId), String(connId)),
    rawDb.$queryRawUnsafe<Array<{ count: bigint }>>(
      'SELECT COUNT(*)::bigint AS count FROM "GameIdentityLink" WHERE "guildId"=$1 AND "nitradoConnId"=$2 AND "status"=\'VERIFIED\'',
      String(guildId), String(connId)),
    rawDb.$queryRawUnsafe<Array<{ count: bigint }>>(
      'SELECT COUNT(*)::bigint AS count FROM "EconomyTransaction" WHERE "guildId"=$1 AND "nitradoConnId"=$2',
      String(guildId), String(connId)),
    rawDb.$queryRawUnsafe<OverviewTx[]>(
      'SELECT "id", "userDiscordId", "delta", "type"::text AS type, "reason", "createdAt" FROM "EconomyTransaction" WHERE "guildId"=$1 AND "nitradoConnId"=$2 ORDER BY "createdAt" DESC LIMIT 10',
      String(guildId), String(connId)),
    rawDb.$queryRawUnsafe<OverviewCasinoRound[]>(
      'SELECT r."bet", r."payout", g."type"::text AS type FROM "CasinoRound" r JOIN "CasinoGame" g ON g."id"=r."gameId" WHERE r."guildId"=$1 AND r."nitradoConnId"=$2 LIMIT 100000',
      String(guildId), String(connId)),
    rawDb.$queryRawUnsafe<OverviewCasinoGame[]>(
      'SELECT "type"::text AS type, "enabled" FROM "CasinoGame" WHERE "guildId"=$1 AND "nitradoConnId"=$2',
      String(guildId), String(connId)),
  ]);

  const buckets = new Map<string, { type: string; rounds: number; wins: number; bet: bigint; payout: bigint }>();
  for (const r of casinoRounds) {
    const cur = buckets.get(r.type) ?? { type: r.type, rounds: 0, wins: 0, bet: 0n, payout: 0n };
    cur.rounds++;
    if (r.payout > 0n) cur.wins++;
    cur.bet += r.bet;
    cur.payout += r.payout;
    buckets.set(r.type, cur);
  }
  const casinoTotalBet = casinoRounds.reduce((a, r) => a + r.bet, 0n);
  const casinoTotalPayout = casinoRounds.reduce((a, r) => a + r.payout, 0n);
  const accAgg = accountAggRows[0] ?? { wallet: 0n, bank: 0n, count: 0n };

  res.json({
    nitradoConnId: connId,
    economy: {
      enabled,
      currencyName: cfg.currencyName,
      emoji: cfg.emoji,
      accounts: Number(accAgg.count),
      links: Number(linkCountRows[0]?.count ?? 0n),
      transactions: Number(txCountRows[0]?.count ?? 0n),
    },
    bank: {
      totalWallet: (accAgg.wallet ?? 0n).toString(),
      totalBank: (accAgg.bank ?? 0n).toString(),
      interestPercent: cfg.bankInterestPercent,
      bankChannelId: cfg.bankChannelId,
    },
    casino: {
      gamesConfigured: casinoGames.length,
      gamesEnabled: casinoGames.filter(g => g.enabled).length,
      rounds: casinoRounds.length,
      totalBet: casinoTotalBet.toString(),
      totalPayout: casinoTotalPayout.toString(),
      houseEdge: (casinoTotalBet - casinoTotalPayout).toString(),
      stats: Array.from(buckets.values()).map(b => ({
        type: b.type, rounds: b.rounds, wins: b.wins, losses: b.rounds - b.wins,
        bet: b.bet.toString(), payout: b.payout.toString(),
      })),
    },
    recentTransactions: recentTx.map(t => ({
      id: t.id, userDiscordId: t.userDiscordId, delta: t.delta.toString(),
      type: t.type, reason: t.reason, createdAt: t.createdAt,
    })),
    coupling: {
      sharedCurrency: true,
      sharedBalance: true,
      directlyBooked: true,
      sharedModels: ['EconomyAccount', 'EconomyTransaction'],
      casinoStatsMovable: true,
      raceConditionsGuarded: true,
      centralTransactionService: 'src/modules/economy/repository.ts',
    },
  });
});
