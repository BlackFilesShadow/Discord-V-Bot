/**
 * Casino V3 dashboard API — Guild + Gameserver scoped.
 *
 * All eight public games share the same visible configuration contract:
 * enabled, configured win chance, payout multiplier, min/max bet and cooldown.
 * Config is persisted through the typed casino registry. Historic CasinoGame
 * rows remain compatibility anchors only.
 */
import { createHash } from 'crypto';
import { Router } from 'express';
import { requireGuildPermission } from '../../middleware/auth';
import prisma from '../../../database/prisma';
import { logAuditDb } from '../../../utils/logger';
import { emitGuildEvent } from '../../socket/emitter';
import {
  CASINO_ALGORITHM_VERSION,
  CASINO_GAME_TYPES,
  LEGACY_CASINO_ALGORITHM_VERSION,
  MAX_CASINO_BET,
  assertCasinoEconomySafe,
  theoreticalCasinoRtpPct,
  type CasinoGameKey,
} from '../../../modules/economy/casinoRules';
import {
  casinoDefinition,
  getCasinoGameConfig,
  isCasinoGameKey,
  listCasinoGameConfigs,
  saveCasinoGameConfig,
  type CasinoGameConfig,
} from '../../../modules/economy/casinoRegistry';

export const casinoRouter = Router({ mergeParams: true });
const VALID_TYPES = new Set<string>(CASINO_GAME_TYPES);
const LEGACY_TYPES = new Set<CasinoGameKey>(['SLOT', 'COINFLIP', 'DICE', 'BLACKJACK']);

type RawDb = {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
};

interface CasinoStatsAggregate {
  type: string | null;
  algorithmVersion: string | null;
  hasAudit: boolean;
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
  return payout > 0n ? 'win' : 'loss';
}

function auditedTypeIsValid(type: string | null, algorithmVersion: string | null): type is CasinoGameKey {
  if (!type || !isCasinoGameKey(type)) return false;
  if (algorithmVersion === CASINO_ALGORITHM_VERSION) return true;
  return algorithmVersion === LEGACY_CASINO_ALGORITHM_VERSION && LEGACY_TYPES.has(type);
}

function logicalRoundType(result: unknown, legacyType: string): string | null {
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const row = result as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(row, 'audit')) {
      const audit = row.audit;
      if (!audit || typeof audit !== 'object' || Array.isArray(audit)) return null;
      const auditRow = audit as Record<string, unknown>;
      const type = typeof auditRow.type === 'string' ? auditRow.type : null;
      const algorithmVersion = typeof auditRow.algorithmVersion === 'string' ? auditRow.algorithmVersion : null;
      return auditedTypeIsValid(type, algorithmVersion) ? type : null;
    }
  }
  return legacyType;
}

function gamePayload(type: CasinoGameKey, config: CasinoGameConfig) {
  const def = casinoDefinition(type);
  const theoreticalRtpPct = theoreticalCasinoRtpPct(type, config.winChancePct, config.payoutMult);
  return {
    type,
    label: def.label,
    emoji: def.emoji,
    description: def.description,
    enabled: config.enabled,
    winChancePct: config.winChancePct,
    fixedOdds: null,
    payoutMult: config.payoutMult,
    minBet: config.minBet.toString(),
    maxBet: config.maxBet.toString(),
    cooldownSeconds: config.cooldownSeconds,
    drawConditionalPct: def.drawConditionalPct,
    theoreticalRtpPct: Number(theoreticalRtpPct.toFixed(2)),
    houseEdgePct: Number((100 - theoreticalRtpPct).toFixed(2)),
  };
}

casinoRouter.get('/games', requireGuildPermission('casino.view'), async (req, res) => {
  const scope = req.guildScope!;
  const connId = scope.nitradoConnId!;
  const games = await listCasinoGameConfigs(scope.guildId, connId);
  res.json({
    nitradoConnId: connId,
    games: games.map(row => gamePayload(row.key, row.config)),
  });
});

casinoRouter.put('/games/:type', requireGuildPermission('casino.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const connId = scope.nitradoConnId!;
  const rawType = String(req.params.type).toUpperCase();
  if (!VALID_TYPES.has(rawType) || !isCasinoGameKey(rawType)) {
    res.status(400).json({ error: 'Unbekannter Game-Type.' });
    return;
  }
  const type = rawType;
  const current = await getCasinoGameConfig(scope.guildId, connId, type);
  const b = req.body ?? {};
  const next: CasinoGameConfig = { ...current };
  const changed: string[] = [];

  if (b.enabled !== undefined) {
    if (typeof b.enabled !== 'boolean') { res.status(400).json({ error: 'enabled muss boolean sein.' }); return; }
    next.enabled = b.enabled;
    changed.push('enabled');
  }
  if (b.winChancePct !== undefined) {
    if (typeof b.winChancePct !== 'number' || !Number.isInteger(b.winChancePct) || b.winChancePct < 1 || b.winChancePct > 99) {
      res.status(400).json({ error: 'winChancePct muss eine ganze Zahl von 1 bis 99 sein.' });
      return;
    }
    next.winChancePct = b.winChancePct;
    changed.push('winChancePct');
  }
  if (b.payoutMult !== undefined) {
    if (typeof b.payoutMult !== 'number' || !Number.isFinite(b.payoutMult) || b.payoutMult < 1 || b.payoutMult > 100) {
      res.status(400).json({ error: 'payoutMult muss zwischen 1 und 100 liegen.' });
      return;
    }
    next.payoutMult = b.payoutMult;
    changed.push('payoutMult');
  }
  if (b.minBet !== undefined) {
    try { next.minBet = BigInt(b.minBet); } catch { res.status(400).json({ error: 'minBet nicht parsebar.' }); return; }
    if (next.minBet < 1n || next.minBet > MAX_CASINO_BET) {
      res.status(400).json({ error: `minBet muss 1..${MAX_CASINO_BET.toString()} sein.` });
      return;
    }
    changed.push('minBet');
  }
  if (b.maxBet !== undefined) {
    try { next.maxBet = BigInt(b.maxBet); } catch { res.status(400).json({ error: 'maxBet nicht parsebar.' }); return; }
    if (next.maxBet < 1n || next.maxBet > MAX_CASINO_BET) {
      res.status(400).json({ error: `maxBet muss 1..${MAX_CASINO_BET.toString()} sein.` });
      return;
    }
    changed.push('maxBet');
  }
  if (b.cooldownSeconds !== undefined) {
    if (typeof b.cooldownSeconds !== 'number' || !Number.isInteger(b.cooldownSeconds) || b.cooldownSeconds < 0 || b.cooldownSeconds > 3600) {
      res.status(400).json({ error: 'cooldownSeconds muss eine ganze Zahl von 0 bis 3600 sein.' });
      return;
    }
    next.cooldownSeconds = b.cooldownSeconds;
    changed.push('cooldownSeconds');
  }
  if (changed.length === 0) {
    res.status(400).json({ error: 'Keine gueltigen Casino-Felder.' });
    return;
  }
  if (next.maxBet < next.minBet) {
    res.status(400).json({ error: 'maxBet muss groesser oder gleich minBet sein.' });
    return;
  }
  try {
    assertCasinoEconomySafe(type, next.winChancePct, next.payoutMult);
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : 'Unsichere Casino-Konfiguration.',
      code: 'CASINO_RTP_UNSAFE',
    });
    return;
  }

  const saved = await saveCasinoGameConfig(scope.guildId, connId, type, next);
  logAuditDb('CASINO_GAME_UPDATED', 'CASINO', {
    actorUserId: req.auth!.userId,
    guildId: scope.guildId,
    details: {
      nitradoConnId: connId,
      type,
      fields: changed,
      before: {
        enabled: current.enabled,
        winChancePct: current.winChancePct,
        payoutMult: current.payoutMult,
        minBet: current.minBet.toString(),
        maxBet: current.maxBet.toString(),
        cooldownSeconds: current.cooldownSeconds,
      },
      after: {
        enabled: saved.enabled,
        winChancePct: saved.winChancePct,
        payoutMult: saved.payoutMult,
        minBet: saved.minBet.toString(),
        maxBet: saved.maxBet.toString(),
        cooldownSeconds: saved.cooldownSeconds,
        theoreticalRtpPct: Number(theoreticalCasinoRtpPct(type, saved.winChancePct, saved.payoutMult).toFixed(2)),
      },
    },
  });
  emitGuildEvent(scope.guildId, {
    type: 'settings.changed',
    payload: { guildId: scope.guildId, slotId: connId },
  });
  res.json({ nitradoConnId: connId, ...gamePayload(type, saved) });
});

casinoRouter.get('/stats', requireGuildPermission('casino.view'), async (req, res) => {
  const scope = req.guildScope!;
  const connId = scope.nitradoConnId!;
  const rows = await (prisma as unknown as RawDb).$queryRawUnsafe<CasinoStatsAggregate[]>(
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
       JOIN "CasinoGame" g ON g."id" = r."gameId"
      WHERE r."guildId" = $1 AND r."nitradoConnId" = $2
      GROUP BY CASE WHEN r."result" ? 'audit' THEN r."result"->'audit'->>'type' ELSE g."type"::text END,
               CASE WHEN r."result" ? 'audit' THEN r."result"->'audit'->>'algorithmVersion' ELSE NULL END,
               (r."result" ? 'audit')`,
    String(scope.guildId), String(connId),
  );
  res.json({
    nitradoConnId: connId,
    stats: rows
      .filter(row => row.hasAudit ? auditedTypeIsValid(row.type, row.algorithmVersion) : !!row.type && isCasinoGameKey(row.type))
      .map(row => ({
        type: row.type!,
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
    rounds: rounds.map(r => {
      const type = logicalRoundType(r.result, r.game.type);
      const outcome = storedOutcome(r.result, r.payout);
      return {
        id: r.id,
        type: type ?? 'UNKNOWN',
        userDiscordId: r.userDiscordId,
        outcome,
        win: outcome === 'win',
        bet: r.bet.toString(),
        payout: r.payout.toString(),
        result: r.result,
        serverSeedHash: createHash('sha256').update(r.serverSeed).digest('hex'),
        nonce: r.nonce.toString(),
        createdAt: r.createdAt,
      };
    }),
  });
});
