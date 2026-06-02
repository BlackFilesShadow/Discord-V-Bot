/**
 * Economy: Config + Accounts + Transactions.
 *
 * GET   /config                         -> Config-Snapshot
 * PUT   /config                         -> Update (Owner / economy.manage)
 * GET   /accounts/:userDiscordId        -> Account + letzte Tx
 * POST  /accounts/:userDiscordId/admin-pay  body: { delta, reason } -> ADMIN_PAY (Owner / economy.manage)
 */
import { Router } from 'express';
import prisma from '../../../database/prisma';
import { requireGuildPermission } from '../../middleware/auth';
import {
  getConfig, upsertConfig, getOrCreateAccount, recentTransactions, adminPay,
} from '../../../modules/economy/repository';
import { asUserDiscordId } from '../../../types/scope';
import { logAuditDb } from '../../../utils/logger';
import { emitGuildEvent } from '../../socket/emitter';

export const economyRouter = Router({ mergeParams: true });

// Sicherheits-Bound: ±10^15 (1 Billiarde) verhindert Absurd-Werte / Front-End-Overflow.
// Account-Spalten sind BigInt in der DB — kein DB-Overflow, aber UI/JS-Number-Range wären irgendwann ein Problem.
const ECONOMY_DELTA_MAX = 1_000_000_000_000_000n;
const ECONOMY_DELTA_MIN = -ECONOMY_DELTA_MAX;

economyRouter.get('/config', requireGuildPermission('economy.view'), async (req, res) => {
  const cfg = await getConfig(req.guildScope!.guildId);
  // BigInt is OK in JSON (we don't have any here, startBalance is Int)
  res.json({
    currencyName: cfg.currencyName,
    emoji: cfg.emoji,
    enabled: cfg.enabled,
    startBalance: cfg.startBalance,
    playtimeRewardPercent: cfg.playtimeRewardPercent,
    bankInterestPercent: cfg.bankInterestPercent,
    bankChannelId: cfg.bankChannelId,
  });
});

economyRouter.put('/config', requireGuildPermission('economy.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const b = req.body ?? {};
  const patch: Record<string, unknown> = {};
  if (typeof b.currencyName === 'string' && b.currencyName.length >= 1 && b.currencyName.length <= 40) patch.currencyName = b.currencyName;
  if (typeof b.emoji === 'string' && b.emoji.length >= 1 && b.emoji.length <= 40) patch.emoji = b.emoji;
  if (typeof b.enabled === 'boolean') patch.enabled = b.enabled;
  if (typeof b.startBalance === 'number' && Number.isInteger(b.startBalance) && b.startBalance >= 0 && b.startBalance <= 1_000_000_000) patch.startBalance = b.startBalance;
  if (typeof b.playtimeRewardPercent === 'number' && Number.isInteger(b.playtimeRewardPercent) && b.playtimeRewardPercent >= 0 && b.playtimeRewardPercent <= 1000) patch.playtimeRewardPercent = b.playtimeRewardPercent;
  if (typeof b.bankInterestPercent === 'number' && Number.isInteger(b.bankInterestPercent) && b.bankInterestPercent >= 0 && b.bankInterestPercent <= 100) patch.bankInterestPercent = b.bankInterestPercent;
  if (b.bankChannelId === null || (typeof b.bankChannelId === 'string' && /^\d{17,20}$/.test(b.bankChannelId))) patch.bankChannelId = b.bankChannelId;

  const cfg = await upsertConfig(scope.guildId, patch);
  logAuditDb('ECONOMY_CONFIG_UPDATED', 'ECONOMY', { actorUserId: req.auth!.userId, guildId: scope.guildId, details: { fields: Object.keys(patch) } });
  emitGuildEvent(scope.guildId, { type: 'settings.changed', payload: { guildId: scope.guildId, slotId: '' } });
  res.json({
    currencyName: cfg.currencyName,
    emoji: cfg.emoji,
    enabled: cfg.enabled,
    startBalance: cfg.startBalance,
    playtimeRewardPercent: cfg.playtimeRewardPercent,
    bankInterestPercent: cfg.bankInterestPercent,
    bankChannelId: cfg.bankChannelId,
  });
});

economyRouter.get('/accounts/:userDiscordId', requireGuildPermission('economy.view'), async (req, res) => {
  const scope = req.guildScope!;
  let userId;
  try { userId = asUserDiscordId(String(req.params.userDiscordId)); } catch { res.status(400).json({ error: 'userDiscordId ungueltig.' }); return; }
  const acc = await getOrCreateAccount(scope.guildId, userId);
  const tx = await recentTransactions(scope.guildId, userId, 20);
  res.json({
    userDiscordId: acc.userDiscordId,
    walletBalance: acc.walletBalance.toString(),
    bankBalance: acc.bankBalance.toString(),
    lifetimeEarned: acc.lifetimeEarned.toString(),
    lifetimeSpent: acc.lifetimeSpent.toString(),
    recentTransactions: tx.map(t => ({
      id: t.id, delta: t.delta.toString(), type: t.type, reason: t.reason, createdAt: t.createdAt,
    })),
  });
});

economyRouter.post('/accounts/:userDiscordId/admin-pay', requireGuildPermission('economy.manage'), async (req, res) => {
  const scope = req.guildScope!;
  let target;
  try { target = asUserDiscordId(String(req.params.userDiscordId)); } catch { res.status(400).json({ error: 'userDiscordId ungueltig.' }); return; }
  const { delta, reason } = req.body ?? {};
  if (typeof delta !== 'string' && typeof delta !== 'number') { res.status(400).json({ error: 'delta muss string oder number sein.' }); return; }
  let bigDelta: bigint;
  try { bigDelta = BigInt(delta as string | number); } catch { res.status(400).json({ error: 'delta nicht parsebar.' }); return; }
  if (bigDelta === 0n) { res.status(400).json({ error: 'delta darf nicht 0 sein.' }); return; }
  if (bigDelta > ECONOMY_DELTA_MAX || bigDelta < ECONOMY_DELTA_MIN) {
    res.status(400).json({ error: `delta ausserhalb des erlaubten Bereichs (±${ECONOMY_DELTA_MAX.toString()}).` });
    return;
  }
  if (typeof reason !== 'string' || reason.length < 3 || reason.length > 200) { res.status(400).json({ error: 'reason 3..200 Zeichen.' }); return; }

  try {
    await adminPay({
      guildId: scope.guildId,
      targetUserId: target,
      delta: bigDelta,
      reason,
      actorDiscordId: asUserDiscordId(scope.actorDiscordId),
    });
    logAuditDb('ECONOMY_ADMIN_PAY', 'ECONOMY', {
      actorUserId: req.auth!.userId, guildId: scope.guildId,
      details: { target, delta: bigDelta.toString(), reason },
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

/**
 * GET /overview — Wirtschaft-Sammelansicht fuer das Dashboard.
 * Ersetzt den frueheren Economy-`/status` Discord-Command (Kollision mit
 * user/status.ts) durch eine guild-weite, read-only Uebersicht:
 * Economy-Status, Bank-Status, Casino-Status, Transaktionen, Links, Casino-Stats
 * und eine statische Casino/Bank-Kopplungsanalyse.
 */
economyRouter.get('/overview', requireGuildPermission('economy.view'), async (req, res) => {
  const guildId = req.guildScope!.guildId;

  const [cfg, accAgg, accountCount, linkCount, txCount, recentTx, casinoRounds, casinoGames] = await Promise.all([
    getConfig(guildId),
    prisma.economyAccount.aggregate({ where: { guildId }, _sum: { walletBalance: true, bankBalance: true } }),
    prisma.economyAccount.count({ where: { guildId } }),
    prisma.economyLink.count({ where: { guildId } }),
    prisma.economyTransaction.count({ where: { guildId } }),
    prisma.economyTransaction.findMany({
      where: { guildId }, orderBy: { createdAt: 'desc' }, take: 10,
      select: { id: true, userDiscordId: true, delta: true, type: true, reason: true, createdAt: true },
    }),
    prisma.casinoRound.findMany({
      where: { guildId }, select: { bet: true, payout: true, game: { select: { type: true } } }, take: 100_000,
    }),
    prisma.casinoGame.findMany({ where: { guildId }, select: { type: true, enabled: true } }),
  ]);

  // Casino-Stats pro Spieltyp aggregieren.
  const buckets = new Map<string, { type: string; rounds: number; wins: number; bet: bigint; payout: bigint }>();
  for (const r of casinoRounds) {
    const k = r.game.type;
    const cur = buckets.get(k) ?? { type: k, rounds: 0, wins: 0, bet: 0n, payout: 0n };
    cur.rounds++;
    if (r.payout > 0n) cur.wins++;
    cur.bet += r.bet;
    cur.payout += r.payout;
    buckets.set(k, cur);
  }
  const casinoTotalBet = casinoRounds.reduce((a, r) => a + r.bet, 0n);
  const casinoTotalPayout = casinoRounds.reduce((a, r) => a + r.payout, 0n);

  res.json({
    economy: {
      enabled: cfg.enabled,
      currencyName: cfg.currencyName,
      emoji: cfg.emoji,
      accounts: accountCount,
      links: linkCount,
      transactions: txCount,
    },
    bank: {
      totalWallet: (accAgg._sum.walletBalance ?? 0n).toString(),
      totalBank: (accAgg._sum.bankBalance ?? 0n).toString(),
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
    // Statische Kopplungsanalyse (Spec §10, Fragen 1–7). Quelle: Datenmodell + repository.ts.
    coupling: {
      sharedCurrency: true, // Casino bucht auf EconomyAccount.walletBalance (gleiche Waehrung wie Bank/Economy)
      sharedBalance: true, // CasinoRound nutzt walletBalance des Users
      directlyBooked: true, // Gewinne/Verluste als EconomyTransaction CASINO_BET / CASINO_PAYOUT
      sharedModels: ['EconomyAccount', 'EconomyTransaction'],
      casinoStatsMovable: true, // /casino-stats ist read-only ueber CasinoRound — verschiebbar ohne Spiele zu brechen
      raceConditionsGuarded: true, // economy/repository.ts kapselt Balance-Aenderungen in DB-Transaktionen
      centralTransactionService: 'src/modules/economy/repository.ts',
    },
  });
});
