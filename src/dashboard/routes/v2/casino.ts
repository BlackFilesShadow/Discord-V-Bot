/**
 * Casino: Game-Konfiguration + Stats.
 *
 * GET    /games               -> alle Games der Guild
 * PUT    /games/:type         body: { winChancePct, minBet, maxBet, enabled, configJson? }
 * GET    /stats               -> aggregierte Win-Rate je Type
 * GET    /rounds              -> letzte 100 Rounds (Audit)
 */
import { Router } from 'express';
import { requireGuildPermission } from '../../middleware/auth';
import prisma from '../../../database/prisma';
import type { CasinoGameType } from '@prisma/client';
import { logAudit } from '../../../utils/logger';

export const casinoRouter = Router({ mergeParams: true });

const VALID_TYPES = new Set<CasinoGameType>(['SLOT', 'COINFLIP', 'DICE', 'BLACKJACK']);

casinoRouter.get('/games', requireGuildPermission('casino.view'), async (req, res) => {
  const scope = req.guildScope!;
  const games = await prisma.casinoGame.findMany({ where: { guildId: scope.guildId } });
  res.json({
    games: games.map(g => ({
      type: g.type, enabled: g.enabled, winChancePct: g.winChancePct,
      minBet: g.minBet.toString(), maxBet: g.maxBet.toString(),
      payoutMult: g.payoutMult,
    })),
  });
});

casinoRouter.put('/games/:type', requireGuildPermission('casino.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const t = String(req.params.type) as CasinoGameType;
  if (!VALID_TYPES.has(t)) { res.status(400).json({ error: 'Unbekannter Game-Type.' }); return; }
  const b = req.body ?? {};
  const data: Record<string, unknown> = {};
  if (typeof b.enabled === 'boolean') data.enabled = b.enabled;
  if (typeof b.winChancePct === 'number' && b.winChancePct >= 1 && b.winChancePct <= 99 && Number.isInteger(b.winChancePct)) data.winChancePct = b.winChancePct;
  if (typeof b.payoutMult === 'number' && b.payoutMult >= 1 && b.payoutMult <= 100) data.payoutMult = b.payoutMult;
  if (b.minBet !== undefined) {
    let v: bigint;
    try { v = BigInt(b.minBet); } catch { res.status(400).json({ error: 'minBet nicht parsebar.' }); return; }
    if (v < 1n) { res.status(400).json({ error: 'minBet >= 1' }); return; }
    data.minBet = v;
  }
  if (b.maxBet !== undefined) {
    let v: bigint;
    try { v = BigInt(b.maxBet); } catch { res.status(400).json({ error: 'maxBet nicht parsebar.' }); return; }
    if (v < 1n) { res.status(400).json({ error: 'maxBet >= 1' }); return; }
    data.maxBet = v;
  }

  const g = await prisma.casinoGame.upsert({
    where: { guildId_type: { guildId: scope.guildId, type: t } },
    create: { guildId: scope.guildId, type: t, ...data },
    update: data,
  });
  logAudit('CASINO_GAME_UPDATED', 'CASINO', { guildId: scope.guildId, type: t, actor: scope.actorDiscordId });
  res.json({
    type: g.type, enabled: g.enabled, winChancePct: g.winChancePct,
    minBet: g.minBet.toString(), maxBet: g.maxBet.toString(), payoutMult: g.payoutMult,
  });
});

casinoRouter.get('/stats', requireGuildPermission('casino.view'), async (req, res) => {
  const scope = req.guildScope!;
  // Win/Loss aus payout > 0 ableiten; type per JOIN aus Game.
  const rounds = await prisma.casinoRound.findMany({
    where: { guildId: scope.guildId },
    select: { bet: true, payout: true, game: { select: { type: true } } },
    take: 100_000,
  });
  const buckets = new Map<string, { type: CasinoGameType; wins: number; losses: number; bet: bigint; payout: bigint }>();
  for (const r of rounds) {
    const k = r.game.type;
    const cur = buckets.get(k) ?? { type: r.game.type, wins: 0, losses: 0, bet: 0n, payout: 0n };
    if (r.payout > 0n) cur.wins++; else cur.losses++;
    cur.bet += r.bet;
    cur.payout += r.payout;
    buckets.set(k, cur);
  }
  res.json({
    stats: Array.from(buckets.values()).map(b => ({
      type: b.type, wins: b.wins, losses: b.losses,
      bet: b.bet.toString(), payout: b.payout.toString(),
    })),
  });
});

casinoRouter.get('/rounds', requireGuildPermission('casino.view'), async (req, res) => {
  const scope = req.guildScope!;
  const rounds = await prisma.casinoRound.findMany({
    where: { guildId: scope.guildId },
    orderBy: { createdAt: 'desc' },
    take: 100,
    include: { game: { select: { type: true } } },
  });
  res.json({
    rounds: rounds.map(r => ({
      id: r.id, type: r.game.type, userDiscordId: r.userDiscordId,
      win: r.payout > 0n,
      bet: r.bet.toString(), payout: r.payout.toString(),
      result: r.result, nonce: r.nonce.toString(), createdAt: r.createdAt,
    })),
  });
});
