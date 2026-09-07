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
import {
  CASINO_GAME_TYPES,
  MAX_CASINO_BET,
  assertCasinoEconomySafe,
  casinoDefaults,
  theoreticalCasinoRtpPct,
} from '../../../modules/economy/casinoRules';

export const casinoRouter = Router({ mergeParams: true });

const VALID_TYPES = new Set<CasinoGameType>(CASINO_GAME_TYPES);

type RawDb = {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
};

interface CasinoStatsAggregate {
  type: CasinoGameType;
  rounds: bigint;
  wins: bigint;
  draws: bigint;
  bet: bigint;
  payout: bigint;
}

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

function gamePayload(type: CasinoGameType, row: {
  enabled: boolean;
  winChancePct: number;
  minBet: bigint;
  maxBet: bigint;
  payoutMult: number;
} | null) {
  const defaults = casinoDefaults(type);
  const enabled = row?.enabled ?? defaults.enabled;
  const winChancePct = row?.winChancePct ?? defaults.winChancePct;
  const minBet = row?.minBet ?? defaults.minBet;
  const maxBet = row?.maxBet ?? defaults.maxBet;
  const payoutMult = row?.payoutMult ?? defaults.payoutMult;
  const theoreticalRtpPct = theoreticalCasinoRtpPct(type, winChancePct, payoutMult);
  return {
    type,
    enabled,
    winChancePct: type === 'SLOT' ? winChancePct : null,
    fixedOdds: type === 'COINFLIP' ? '50/50' : type === 'DICE' ? '1/6' : type === 'BLACKJACK' ? 'Kartenlogik' : null,
    minBet: minBet.toString(),
    maxBet: maxBet.toString(),
    payoutMult,
    theoreticalRtpPct: Number(theoreticalRtpPct.toFixed(2)),
    houseEdgePct: Number((100 - theoreticalRtpPct).toFixed(2)),
  };
}

casinoRouter.get('/games', requireGuildPermission('casino.view'), async (req, res) => {
  const scope = req.guildScope!;
  const connId = scope.nitradoConnId!;
  const games = await prisma.casinoGame.findMany({
    where: { guildId: scope.guildId, nitradoConnId: connId },
  });
  const byType = new Map(games.map(g => [g.type, g] as const));
  res.json({
    nitradoConnId: connId,
    games: CASINO_GAME_TYPES.map(type => gamePayload(type, byType.get(type) ?? null)),
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
    select: { enabled: true, winChancePct: true, minBet: true, maxBet: true, payoutMult: true },
  });
  const defaults = casinoDefaults(t);
  const effectiveEnabled = (data.enabled as boolean | undefined) ?? current?.enabled ?? defaults.enabled;
  const effectiveWinChancePct = (data.winChancePct as number | undefined) ?? current?.winChancePct ?? defaults.winChancePct;
  const effectivePayoutMult = (data.payoutMult as number | undefined) ?? current?.payoutMult ?? defaults.payoutMult;
  const effectiveMin = (data.minBet as bigint | undefined) ?? current?.minBet ?? defaults.minBet;
  const effectiveMax = (data.maxBet as bigint | undefined) ?? current?.maxBet ?? defaults.maxBet;
  if (effectiveMax < effectiveMin) {
    res.status(400).json({ error: 'maxBet muss groesser oder gleich minBet sein.' });
    return;
  }
  if (effectiveEnabled) {
    try {
      assertCasinoEconomySafe(t, effectiveWinChancePct, effectivePayoutMult);
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : 'Unsichere Casino-Konfiguration.',
        code: 'CASINO_RTP_UNSAFE',
      });
      return;
    }
  }

  const g = await prisma.casinoGame.upsert({
    where: { guildServerType: { guildId: scope.guildId, nitradoConnId: connId, type: t } },
    create: {
      guildId: scope.guildId,
      nitradoConnId: connId,
      type: t,
      enabled: effectiveEnabled,
      winChancePct: effectiveWinChancePct,
      payoutMult: effectivePayoutMult,
      minBet: effectiveMin,
      maxBet: effectiveMax,
    },
    update: data,
  });
  logAuditDb('CASINO_GAME_UPDATED', 'CASINO', {
    actorUserId: req.auth!.userId,
    guildId: scope.guildId,
    details: {
      nitradoConnId: connId,
      type: t,
      fields: Object.keys(data),
      before: current ? {
        enabled: current.enabled,
        winChancePct: t === 'SLOT' ? current.winChancePct : null,
        payoutMult: current.payoutMult,
        minBet: current.minBet.toString(),
        maxBet: current.maxBet.toString(),
      } : null,
      after: {
        enabled: g.enabled,
        winChancePct: t === 'SLOT' ? g.winChancePct : null,
        payoutMult: g.payoutMult,
        minBet: g.minBet.toString(),
        maxBet: g.maxBet.toString(),
        theoreticalRtpPct: Number(theoreticalCasinoRtpPct(t, g.winChancePct, g.payoutMult).toFixed(2)),
      },
    },
  });
  emitGuildEvent(scope.guildId, {
    type: 'settings.changed',
    payload: { guildId: scope.guildId, slotId: connId },
  });
  res.json({ nitradoConnId: connId, ...gamePayload(t, g) });
});

casinoRouter.get('/stats', requireGuildPermission('casino.view'), async (req, res) => {
  const scope = req.guildScope!;
  const connId = scope.nitradoConnId!;
  const rows = await (prisma as unknown as RawDb).$queryRawUnsafe<CasinoStatsAggregate[]>(
    `SELECT g."type"::text AS "type",
            COUNT(*)::bigint AS "rounds",
            COUNT(*) FILTER (WHERE r."result"->>'draw' = 'true')::bigint AS "draws",
            COUNT(*) FILTER (
              WHERE COALESCE(r."result"->>'draw', 'false') <> 'true'
                AND CASE
                      WHEN r."result" ? 'won' THEN r."result"->>'won' = 'true'
                      ELSE r."payout" > 0
                    END
            )::bigint AS "wins",
            COALESCE(SUM(r."bet"), 0)::bigint AS "bet",
            COALESCE(SUM(r."payout"), 0)::bigint AS "payout"
       FROM "CasinoRound" r
       JOIN "CasinoGame" g
         ON g."id" = r."gameId"
        AND g."guildId" = r."guildId"
        AND g."nitradoConnId" = r."nitradoConnId"
      WHERE r."guildId" = $1 AND r."nitradoConnId" = $2
      GROUP BY g."type"`,
    String(scope.guildId), String(connId),
  );
  res.json({
    nitradoConnId: connId,
    stats: rows.map(row => ({
      type: row.type,
      wins: Number(row.wins),
      draws: Number(row.draws),
      losses: Number(row.rounds - row.wins - row.draws),
      bet: row.bet.toString(),
      payout: row.payout.toString(),
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
      serverSeedHash: r.serverSeed ? require('crypto').createHash('sha256').update(r.serverSeed).digest('hex') : null,
      nonce: r.nonce.toString(),
      createdAt: r.createdAt,
    })),
  });
});
