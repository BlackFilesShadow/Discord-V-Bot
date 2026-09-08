/**
 * Economy: Config + Accounts + Transactions — immer Guild+Gameserver-gescopt.
 *
 * Kanonische Aktivierung ist ServerSettings.economyActive. Legacy-Mirror bleiben
 * kompatibel, aber die sichtbare Spielzeit-Belohnung schreibt seit V3 direkt die
 * produktive EconomyRewardRule `playtime:default` statt eines toten Prozentfelds.
 */
import { Router } from 'express';
import prisma from '../../../database/prisma';
import { requireGuildPermission } from '../../middleware/auth';
import { getConfig, getAccountOrZero, recentTransactions } from '../../../modules/economy/repository';
import {
  getInterestBasisPoints,
  interestBasisPointsToPercent,
  parseInterestPercent,
  setInterestBasisPoints,
} from '../../../modules/economy/interestRate';
import { applyDashboardAdminPay } from '../../../modules/economy/dashboardAdminPay';
import {
  isCasinoGameKey,
  listCasinoGameConfigs,
  type CasinoGameKey,
} from '../../../modules/economy/casinoRegistry';
import {
  CASINO_ALGORITHM_VERSION,
  LEGACY_CASINO_ALGORITHM_VERSION,
} from '../../../modules/economy/casinoRules';
import { asUserDiscordId } from '../../../types/scope';
import { logAuditDb } from '../../../utils/logger';
import { emitGuildEvent } from '../../socket/emitter';

export const economyRouter = Router({ mergeParams: true });
const ECONOMY_DELTA_MAX = 1_000_000_000_000_000n;
const ECONOMY_DELTA_MIN = -ECONOMY_DELTA_MAX;
const PLAYTIME_REWARD_MAX = 1_000_000_000_000_000;
const LEGACY_CASINO_TYPES = new Set<CasinoGameKey>(['SLOT', 'COINFLIP', 'DICE', 'BLACKJACK']);

type RawDb = { $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T> };
const rawDb = prisma as unknown as RawDb;

function scoped(req: Parameters<Parameters<typeof economyRouter.get>[1]>[0]) {
  const scope = req.guildScope!;
  if (!scope.nitradoConnId) throw new Error('Economy-Gameserver-Scope fehlt.');
  return { scope, connId: scope.nitradoConnId };
}

function auditedCasinoTypeIsValid(type: string | null, algorithmVersion: string | null): type is CasinoGameKey {
  if (!type || !isCasinoGameKey(type)) return false;
  if (algorithmVersion === CASINO_ALGORITHM_VERSION) return true;
  return algorithmVersion === LEGACY_CASINO_ALGORITHM_VERSION && LEGACY_CASINO_TYPES.has(type);
}

async function economyEnabled(guildId: string, nitradoConnId: string): Promise<boolean> {
  const settings = await prisma.serverSettings.findUnique({
    where: { guildId_nitradoConnId: { guildId, nitradoConnId } },
    select: { economyActive: true },
  });
  return settings?.economyActive ?? false;
}

async function playtimeRewardAmount(guildId: string, nitradoConnId: string): Promise<number> {
  const rule = await prisma.economyRewardRule.findUnique({
    where: { guildId_nitradoConnId_ruleKey: { guildId, nitradoConnId, ruleKey: 'playtime:default' } },
    select: { enabled: true, baseAmount: true },
  });
  if (!rule?.enabled || rule.baseAmount <= 0n) return 0;
  const safe = rule.baseAmount > BigInt(PLAYTIME_REWARD_MAX) ? BigInt(PLAYTIME_REWARD_MAX) : rule.baseAmount;
  return Number(safe);
}

function configPayload(
  connId: string,
  cfg: Awaited<ReturnType<typeof getConfig>>,
  enabled: boolean,
  interestBasisPoints: number,
  playtimePer10Min: number,
) {
  return {
    nitradoConnId: connId,
    currencyName: cfg.currencyName,
    emoji: cfg.emoji,
    enabled,
    startBalance: cfg.startBalance,
    // New canonical field. The old name is kept as a value-compatible alias for
    // rolling clients; both now describe an amount per complete 10-minute bucket.
    playtimeRewardPer10Min: playtimePer10Min,
    playtimeRewardPercent: playtimePer10Min,
    bankInterestPercent: interestBasisPointsToPercent(interestBasisPoints),
    bankInterestBasisPoints: interestBasisPoints,
    bankChannelId: cfg.bankChannelId,
  };
}

economyRouter.get('/config', requireGuildPermission('economy.view'), async (req, res) => {
  const { scope, connId } = scoped(req);
  const [cfg, enabled, interestBasisPoints, playtimePer10Min] = await Promise.all([
    getConfig(scope.guildId, connId),
    economyEnabled(scope.guildId, connId),
    getInterestBasisPoints(scope.guildId, connId),
    playtimeRewardAmount(scope.guildId, connId),
  ]);
  res.json(configPayload(connId, cfg, enabled, interestBasisPoints, playtimePer10Min));
});

economyRouter.put('/config', requireGuildPermission('economy.manage'), async (req, res) => {
  const { scope, connId } = scoped(req);
  const b = req.body ?? {};
  const [current, currentEnabled, currentInterestBasisPoints, currentPlaytimePer10Min, currentPlaytimeRule] = await Promise.all([
    getConfig(scope.guildId, connId),
    economyEnabled(scope.guildId, connId),
    getInterestBasisPoints(scope.guildId, connId),
    playtimeRewardAmount(scope.guildId, connId),
    prisma.economyRewardRule.findUnique({
      where: { guildId_nitradoConnId_ruleKey: { guildId: scope.guildId, nitradoConnId: connId, ruleKey: 'playtime:default' } },
      select: { rewardTarget: true, dailyCap: true, cooldownSeconds: true },
    }),
  ]);

  const patch: Record<string, unknown> = {};
  if (typeof b.currencyName === 'string' && b.currencyName.length >= 1 && b.currencyName.length <= 40) patch.currencyName = b.currencyName;
  if (typeof b.emoji === 'string' && b.emoji.length >= 1 && b.emoji.length <= 40) patch.emoji = b.emoji;
  if (typeof b.enabled === 'boolean') patch.enabled = b.enabled;
  if (typeof b.startBalance === 'number' && Number.isInteger(b.startBalance) && b.startBalance >= 0 && b.startBalance <= 1_000_000_000) patch.startBalance = b.startBalance;

  const requestedPlaytime = b.playtimeRewardPer10Min ?? b.playtimeRewardPercent;
  if (requestedPlaytime !== undefined) {
    if (typeof requestedPlaytime !== 'number' || !Number.isInteger(requestedPlaytime) || requestedPlaytime < 0 || requestedPlaytime > PLAYTIME_REWARD_MAX) {
      res.status(400).json({ error: `playtimeRewardPer10Min muss eine ganze Zahl von 0 bis ${PLAYTIME_REWARD_MAX} sein.` });
      return;
    }
    patch.playtimeRewardPer10Min = requestedPlaytime;
  }
  if (Object.prototype.hasOwnProperty.call(b, 'bankInterestPercent')) {
    try { patch.bankInterestBasisPoints = parseInterestPercent(b.bankInterestPercent); }
    catch (error) { res.status(400).json({ error: (error as Error).message }); return; }
  }
  if (b.bankChannelId === null || (typeof b.bankChannelId === 'string' && /^\d{17,20}$/.test(b.bankChannelId))) patch.bankChannelId = b.bankChannelId;
  if (Object.keys(patch).length === 0) {
    res.status(400).json({ error: 'Keine gueltigen Economy-Felder.' });
    return;
  }

  const interestBasisPoints = (patch.bankInterestBasisPoints as number | undefined) ?? currentInterestBasisPoints;
  const playtimePer10Min = (patch.playtimeRewardPer10Min as number | undefined) ?? currentPlaytimePer10Min;
  const merged = {
    currencyName: (patch.currencyName as string | undefined) ?? current.currencyName,
    emoji: (patch.emoji as string | undefined) ?? current.emoji,
    enabled: (patch.enabled as boolean | undefined) ?? currentEnabled,
    startBalance: (patch.startBalance as number | undefined) ?? current.startBalance,
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
        // Compatibility mirror only; runtime reads EconomyRewardRule.
        playtimeRewardPercent: playtimePer10Min,
        bankInterestPercent: Math.floor(interestBasisPoints / 100),
        bankChannelId: merged.bankChannelId,
      },
      update: {
        currencyName: merged.currencyName,
        emoji: merged.emoji,
        enabled: merged.enabled,
        startBalance: merged.startBalance,
        playtimeRewardPercent: playtimePer10Min,
        bankInterestPercent: Math.floor(interestBasisPoints / 100),
        bankChannelId: merged.bankChannelId,
      },
    });
    await setInterestBasisPoints(scope.guildId, connId, interestBasisPoints, tx);
    await tx.serverSettings.upsert({
      where: { guildId_nitradoConnId: { guildId: scope.guildId, nitradoConnId: connId } },
      create: { guildId: scope.guildId, nitradoConnId: connId, economyActive: merged.enabled },
      update: { economyActive: merged.enabled },
    });
    const slotCfg = await tx.economySlotConfig.upsert({
      where: { guildId_nitradoConnId: { guildId: scope.guildId, nitradoConnId: connId } },
      create: { guildId: scope.guildId, nitradoConnId: connId, enabled: merged.enabled },
      update: { enabled: merged.enabled },
    });

    if (Object.prototype.hasOwnProperty.call(patch, 'playtimeRewardPer10Min')) {
      await tx.economyRewardRule.upsert({
        where: { guildId_nitradoConnId_ruleKey: { guildId: scope.guildId, nitradoConnId: connId, ruleKey: 'playtime:default' } },
        create: {
          guildId: scope.guildId,
          nitradoConnId: connId,
          ruleKey: 'playtime:default',
          enabled: playtimePer10Min > 0,
          baseAmount: BigInt(playtimePer10Min),
          rewardTarget: currentPlaytimeRule?.rewardTarget ?? slotCfg.rewardTarget,
          dailyCap: currentPlaytimeRule?.dailyCap ?? null,
          cooldownSeconds: currentPlaytimeRule?.cooldownSeconds ?? 0,
        },
        update: {
          enabled: playtimePer10Min > 0,
          baseAmount: BigInt(playtimePer10Min),
        },
      });
    }
  });

  const [cfg, savedInterestBasisPoints, savedPlaytimePer10Min] = await Promise.all([
    getConfig(scope.guildId, connId),
    getInterestBasisPoints(scope.guildId, connId),
    playtimeRewardAmount(scope.guildId, connId),
  ]);
  logAuditDb('ECONOMY_CONFIG_UPDATED', 'ECONOMY', {
    actorUserId: req.auth!.userId,
    guildId: scope.guildId,
    details: { nitradoConnId: connId, fields: Object.keys(patch), canonicalActivation: 'ServerSettings.economyActive' },
  });
  emitGuildEvent(scope.guildId, { type: 'settings.changed', payload: { guildId: scope.guildId, slotId: connId } });
  res.json(configPayload(connId, cfg, merged.enabled, savedInterestBasisPoints, savedPlaytimePer10Min));
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
interface OverviewCasinoAggregate {
  type: string | null;
  algorithmVersion: string | null;
  hasAudit: boolean;
  rounds: bigint;
  wins: bigint;
  draws: bigint;
  bet: bigint;
  payout: bigint;
}

/** GET /overview — ausschliesslich fuer den validierten Gameserver. */
economyRouter.get('/overview', requireGuildPermission('economy.view'), async (req, res) => {
  const { scope, connId } = scoped(req);
  const guildId = scope.guildId;
  const [
    cfg,
    interestBasisPoints,
    enabled,
    accountAggRows,
    linkCountRows,
    txCountRows,
    recentTx,
    casinoStats,
    casinoGames,
  ] = await Promise.all([
    getConfig(guildId, connId),
    getInterestBasisPoints(guildId, connId),
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
    rawDb.$queryRawUnsafe<OverviewCasinoAggregate[]>(
      `SELECT CASE WHEN r."result" ? 'audit' THEN r."result"->'audit'->>'type' ELSE g."type"::text END AS "type",
              CASE WHEN r."result" ? 'audit' THEN r."result"->'audit'->>'algorithmVersion' ELSE NULL END AS "algorithmVersion",
              (r."result" ? 'audit') AS "hasAudit",
              COUNT(*)::bigint AS "rounds",
              COUNT(*) FILTER (WHERE r."result"->>'draw' = 'true')::bigint AS "draws",
              COUNT(*) FILTER (
                WHERE COALESCE(r."result"->>'draw', 'false') <> 'true'
                  AND CASE WHEN r."result" ? 'won' THEN r."result"->>'won' = 'true' ELSE r."payout" > 0 END
              )::bigint AS "wins",
              COALESCE(SUM(r."bet"), 0)::bigint AS "bet",
              COALESCE(SUM(r."payout"), 0)::bigint AS "payout"
         FROM "CasinoRound" r
         JOIN "CasinoGame" g
           ON g."id" = r."gameId"
          AND g."guildId" = r."guildId"
          AND g."nitradoConnId" = r."nitradoConnId"
        WHERE r."guildId"=$1 AND r."nitradoConnId"=$2
        GROUP BY CASE WHEN r."result" ? 'audit' THEN r."result"->'audit'->>'type' ELSE g."type"::text END,
                 CASE WHEN r."result" ? 'audit' THEN r."result"->'audit'->>'algorithmVersion' ELSE NULL END,
                 (r."result" ? 'audit')`,
      String(guildId), String(connId)),
    listCasinoGameConfigs(guildId, connId),
  ]);

  // Global totals intentionally include malformed historical rows, but per-game
  // statistics never assign an invalid audit to its compatibility anchor.
  const casinoRounds = casinoStats.reduce((sum, row) => sum + row.rounds, 0n);
  const casinoTotalBet = casinoStats.reduce((sum, row) => sum + row.bet, 0n);
  const casinoTotalPayout = casinoStats.reduce((sum, row) => sum + row.payout, 0n);
  const classifiedCasinoStats = casinoStats.filter(row => (
    row.hasAudit
      ? auditedCasinoTypeIsValid(row.type, row.algorithmVersion)
      : !!row.type && isCasinoGameKey(row.type)
  ));
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
      interestPercent: interestBasisPointsToPercent(interestBasisPoints),
      interestBasisPoints,
      bankChannelId: cfg.bankChannelId,
    },
    casino: {
      gamesConfigured: casinoGames.length,
      gamesEnabled: casinoGames.filter(g => g.config.enabled).length,
      rounds: Number(casinoRounds),
      totalBet: casinoTotalBet.toString(),
      totalPayout: casinoTotalPayout.toString(),
      houseEdge: (casinoTotalBet - casinoTotalPayout).toString(),
      stats: classifiedCasinoStats.map(row => ({
        type: row.type!,
        rounds: Number(row.rounds),
        wins: Number(row.wins),
        draws: Number(row.draws),
        losses: Number(row.rounds - row.wins - row.draws),
        bet: row.bet.toString(),
        payout: row.payout.toString(),
      })),
    },
    recentTransactions: recentTx.map(t => ({
      id: t.id,
      userDiscordId: t.userDiscordId,
      delta: t.delta.toString(),
      type: t.type,
      reason: t.reason,
      createdAt: t.createdAt,
    })),
    coupling: {
      sharedCurrency: true,
      sharedBalance: true,
      directlyBooked: false,
      sharedModels: ['EconomyAccount', 'EconomyLedgerEntry', 'EconomyTransaction', 'CasinoRound'],
      casinoStatsMovable: true,
      raceConditionsGuarded: true,
      centralTransactionService: 'src/modules/economy/ledger.ts',
    },
  });
});
