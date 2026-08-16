import { Router } from 'express';
import { requireGuildPermission } from '../../middleware/auth';
import { getDashboardClient } from '../../clientRegistry';
import {
  createLotteryRound,
  endLotteryNow,
  getCurrentLotteryRound,
  getLotteryRoundById,
  listLotteryHistory,
  type LotteryRoundView,
} from '../../../modules/economy/lottery';
import { asUserDiscordId } from '../../../types/scope';
import { logAuditDb } from '../../../utils/logger';

export const economyLotteryRouter = Router({ mergeParams: true });

type LotteryRequest = Parameters<Parameters<typeof economyLotteryRouter.get>[1]>[0];

function scoped(req: LotteryRequest) {
  const scope = req.guildScope!;
  if (!scope.nitradoConnId) throw new Error('Economy-Gameserver-Scope fehlt.');
  return { scope, connId: scope.nitradoConnId };
}

function serialize(round: LotteryRoundView | null) {
  if (!round) return null;
  return {
    ...round,
    ticketPrice: round.ticketPrice.toString(),
    finalPot: round.finalPot?.toString() ?? null,
    potBalance: round.potBalance.toString(),
  };
}

function parseAmount(value: unknown): bigint {
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error('ticketPrice fehlt.');
  let amount: bigint;
  try { amount = BigInt(value); } catch { throw new Error('ticketPrice ist nicht parsebar.'); }
  if (amount <= 0n || amount > 1_000_000_000_000n) throw new Error('ticketPrice muss 1..1.000.000.000.000 sein.');
  return amount;
}

function parseIntRange(value: unknown, min: number, max: number, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${field} muss ${min}..${max} sein.`);
  }
  return value;
}

function parseDate(value: unknown): Date {
  if (typeof value !== 'string') throw new Error('endsAt muss ein ISO-Datum sein.');
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('endsAt ist ungueltig.');
  return date;
}

economyLotteryRouter.get('/current', requireGuildPermission('economy.view'), async (req, res) => {
  const { scope, connId } = scoped(req);
  const round = await getCurrentLotteryRound(scope.guildId, connId);
  res.json({ nitradoConnId: connId, round: serialize(round) });
});

economyLotteryRouter.get('/history', requireGuildPermission('economy.view'), async (req, res) => {
  const { scope, connId } = scoped(req);
  const rawLimit = Number(req.query.limit ?? 20);
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(50, Math.trunc(rawLimit))) : 20;
  const rounds = await listLotteryHistory(scope.guildId, connId, limit);
  res.json({ nitradoConnId: connId, rounds: rounds.map(serialize) });
});

economyLotteryRouter.get('/:roundId', requireGuildPermission('economy.view'), async (req, res) => {
  const { scope, connId } = scoped(req);
  const round = await getLotteryRoundById(scope.guildId, connId, String(req.params.roundId));
  if (!round) { res.status(404).json({ error: 'Lotterie nicht gefunden.' }); return; }
  res.json(serialize(round));
});

economyLotteryRouter.post('/rounds', requireGuildPermission('economy.manage'), async (req, res) => {
  const { scope, connId } = scoped(req);
  const body = req.body ?? {};
  if (typeof body.channelId !== 'string' || !/^\d{17,20}$/.test(body.channelId)) {
    res.status(400).json({ error: 'channelId muss eine Discord-Kanal-ID sein.' }); return;
  }
  try {
    const round = await createLotteryRound({
      client: getDashboardClient(),
      guildId: scope.guildId,
      nitradoConnId: connId,
      channelId: body.channelId,
      ticketPrice: parseAmount(body.ticketPrice),
      maxTicketsPerUser: parseIntRange(body.maxTicketsPerUser, 1, 10_000, 'maxTicketsPerUser'),
      minParticipants: parseIntRange(body.minParticipants, 2, 100_000, 'minParticipants'),
      endsAt: parseDate(body.endsAt),
      createdByDiscordId: asUserDiscordId(scope.actorDiscordId),
    });
    logAuditDb('LOTTERY_CREATED_DASHBOARD', 'ECONOMY', {
      actorUserId: req.auth!.userId,
      guildId: scope.guildId,
      details: { nitradoConnId: connId, roundId: round.id, potAccountId: round.potAccountId },
    });
    res.status(201).json(serialize(round));
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

economyLotteryRouter.post('/:roundId/end-now', requireGuildPermission('economy.manage'), async (req, res) => {
  const { scope, connId } = scoped(req);
  try {
    const round = await endLotteryNow(getDashboardClient(), scope.guildId, connId, String(req.params.roundId));
    logAuditDb('LOTTERY_ENDED_DASHBOARD', 'ECONOMY', {
      actorUserId: req.auth!.userId,
      guildId: scope.guildId,
      details: { nitradoConnId: connId, roundId: round.id, status: round.status },
    });
    res.json(serialize(round));
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});