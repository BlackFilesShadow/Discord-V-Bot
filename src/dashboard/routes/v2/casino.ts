/**
 * Casino: Game-Konfiguration + Stats — immer Guild+Gameserver-gescopt.
 *
 * `winChancePct` ist nur fuer SLOT eine echte Spielregel. COINFLIP (50/50),
 * DICE (1/6) und BLACKJACK folgen ihren festen Spielregeln und ignorieren den
 * historischen Wert. Die API nimmt deshalb fuer diese Typen keine neue Win-%-
 * Konfiguration mehr an.
 */
import { Router } from 'express';
import { requireGuildPermission } from '../../middleware/auth';
import prisma from '../../../database/prisma';
import type { CasinoGameType } from '@prisma/client';
import { logAuditDb } from '../../../utils/logger';
import { emitGuildEvent } from '../../socket/emitter';

export const casinoRouter = Router({ mergeParams: true });

const VALID_TYPES = new Set<CasinoGameType>(['SLOT', 'COINFLIP', 'DICE', 'BLACKJACK']);
const MAX_CASINO_BET = 1_000_000_000_000_000n;

function storedOutcome(result: unknown, payout: bigint): 'win' | 'draw' | 'loss' {
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const row = result as Record<string, unknown>;
    if (row.draw === true) return 'draw';
    if (row.won === true) return 'win';
    if (row.won === false) return 'loss';
  }
  // Legacy-Runden vor explizitem Outcome-Feld.
  return payout > 0n ? 'win' : 'loss';
}

casinoRouter.get('/games', requireGuildPermission('casino.view'), async (req, res) => {
  const scope = req.guildScope!;
  const connId = scope.nitradoConnId!;
  const games = await prisma.casinoGame.findMany({
    where: { guildId: scope.guildId, nitradoConnId: connId },
  });
  res.json({
    nitradoConnId: connId,
    games: games.map(g => ({
      type: g.type,
      enabled: g.enabled,
      winChancePct: g.type === 'SLOT' ? g.winChancePct : null,
      fixedOdds: g.type === 'COINFLIP' ? '50/50' : g.type === 'DICE' ? '1/6' : g.type === 'BLACKJACK' ? 'Kartenlogik' : null,
      minBet: g.minBet.toString(),
      maxBet: g.maxBet.toString(),
      payoutMult: g.payoutMult,
    })),
  });
});

casinoRouter.put('/games/:type', requireGuildPermission('casino.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const connId = scope.nitradoConnId!;
  const t = String(req.params.type) as CasinoGameType;
  if (!VALID_TYPES.has(t)) { res.status(400).json({ error: 'Unbekannter Game-Type.' }); return; }
  const b = req.body ?? {};
  const data: Record<string, unknown> = {};

  if (typeof b.enabled === 'boolean') data.enabled = b.enabled;
  if (b.winChancePct !== undefined) {
    if (t !== 'SLOT') {
      res.status(400).json({ error: 'winChancePct ist nur fuer SLOT konfigurierbar. COINFLIP, DICE und BLACKJACK haben feste Spielregeln.' });
      return;
    }
    if (typeof b.winChancePct !== 'number' || b.winChancePct < 1 || b.winChancePct > 99 || !Number.isInteger(b.winChancePct)) {
      res.status(400).json({ error: 'winChancePct muss eine ganze Zahl von 1 bis 99 sein.' });
      return;
    }
    data.winChancePct = b.winChancePct;
  }
  if (typeof b.payoutMult === 'number' && b.payoutMult >= 1 && b.payoutMult <= 100 && Number.isFinite(b.payoutMult)) {
    data.payoutMult = b.payoutMult;
  } else if (b.payoutMult !== undefined) {
    res.status(400).json({ error: 'payoutMult muss zwischen 1 und 100 liegen.' });
    return;
  }
  if (b.minBet !== undefined) {
    let v: bigint;
    try { v = BigInt(b.minBet); } catch { res.status(400).json({ error: 'minBet nicht parsebar.' }); return; }
    if (v < 1n) { res.status(400).json({ error: 'minBet >= 1' }); return; }
    if (v > MAX_CASINO_BET) { res.status(400).json({ error: `minBet <= ${MAX_CASINO_BET.toString()}` }); return; }
    data.minBet = v;
  }
  if (b.maxBet !== undefined) {
    let v: bigint;
    try { v = BigInt(b.maxBet); } catch { res.status(400).json({ error: 'maxBet nicht parsebar.' }); return; }
    if (v < 1n) { res.status(400).json({ error: 'maxBet >= 1' }); return; }
    if (v > MAX_CASINO_BET) { res.status(400).json({ error: `maxBet <= ${MAX_CASINO_BET.toString()}` }); return; }
    data.maxBet = v;
  }

  const current = await prisma.casinoGame.findUnique({
    where: { guildServerType: { guildId: scope.guildId, nitradoConnId: connId, type: t } },
    select: { minBet: true, maxBet: true },
  });
  const effectiveMin = (data.minBet as bigint | undefined) ?? current?.minBet ?? 1n;
  const effectiveMax = (data.maxBet as bigint | undefined) ?? current?.maxBet ?? 1_000n;
  if (effectiveMax < effectiveMin) {
    res.status(400).json({ error: 'maxBet muss groesser oder gleich minBet sein.' });
    return;
  }

  const g = await prisma.casinoGame.upsert({
    where: { guildServerType: { guildId: scope.guildId, nitradoConnId: connId, type: t } },
    create: { guildId: scope.guildId, nitradoConnId: connId, type: t, ...data },
    update: data,
  });
  logAuditDb('CASINO_GAME_UPDATED', 'CASINO', {
    actorUserId: req.auth!.userId,
    guildId: scope.guildId,
    details: { nitradoConnId: connId, type: t, fields: Object.keys(data) },
  });
  emitGuildEvent(scope.guildId, {
    type: 'settings.changed',
    payload: { guildId: scope.guildId, slotId: connId },
  });
  res.json({
    nitradoConnId: connId,
    type: g.type,
    enabled: g.enabled,
    winChancePct: g.type === 'SLOT' ? g.winChancePct : null,
    fixedOdds: g.type === 'COINFLIP' ? '50/50' : g.type === 'DICE' ? '1/6' : g.type === 'BLACKJACK' ? 'Kartenlogik' : null,
    minBet: g.minBet.toString(),
    maxBet: g.maxBet.toString(),
    payoutMult: g.payoutMult,
  });
});

casinoRouter.get('/stats', requireGuildPermission('casino.view'), async (req, res) => {
  const scope = req.guildScope!;
  const connId = scope.nitradoConnId!;
  const rounds = await prisma.casinoRound.findMany({
    where: { guildId: scope.guildId, nitradoConnId: connId },
    select: { bet: true, payout: true, result: true, game: { select: { type: true } } },
    take: 100_000,
  });
  const buckets = new Map<string, { type: CasinoGameType; wins: number; draws: number; losses: number; bet: bigint; payout: bigint }>();
  for (const r of rounds) {
    const k = r.game.type;
    const cur = buckets.get(k) ?? { type: r.game.type, wins: 0, draws: 0, losses: 0, bet: 0n, payout: 0n };
    const outcome = storedOutcome(r.result, r.payout);
    if (outcome === 'win') cur.wins++;
    else if (outcome === 'draw') cur.draws++;
    else cur.losses++;
    cur.bet += r.bet;
    cur.payout += r.payout;
    buckets.set(k, cur);
  }
  res.json({
    nitradoConnId: connId,
    stats: Array.from(buckets.values()).map(b => ({
      type: b.type,
      wins: b.wins,
      draws: b.draws,
      losses: b.losses,
      bet: b.bet.toString(),
      payout: b.payout.toString(),
    })),
  });
});

casinoRouter.get('/rounds', requireGuildPermission('casino.view'), async (req, res) => {
  const scope = req.guildScope!;
  const connId = scope.nitradoConnId!;
  const rounds = await prisma.casinoRound.findMany({
    where: { guildId: scope.guildId, nitradoConnId: connId },
    orderBy: { createdAt: 'desc' },
    take: 100,
    include: { game: { select: { type: true } } },
  });
  res.json({
    nitradoConnId: connId,
    rounds: rounds.map(r => ({
      id: r.id,
      type: r.game.type,
      userDiscordId: r.userDiscordId,
      outcome: storedOutcome(r.result, r.payout),
      win: storedOutcome(r.result, r.payout) === 'win',
      bet: r.bet.toString(),
      payout: r.payout.toString(),
      result: r.result,
      nonce: r.nonce.toString(),
      createdAt: r.createdAt,
    })),
  });
});
