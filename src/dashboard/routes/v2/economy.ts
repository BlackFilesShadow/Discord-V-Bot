/**
 * Economy: Config + Accounts + Transactions.
 *
 * GET   /config                         -> Config-Snapshot
 * PUT   /config                         -> Update (Owner / economy.manage)
 * GET   /accounts/:userDiscordId        -> Account + letzte Tx
 * POST  /accounts/:userDiscordId/admin-pay  body: { delta, reason } -> ADMIN_PAY (Owner / economy.manage)
 */
import { Router } from 'express';
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
