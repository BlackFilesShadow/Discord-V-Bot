import { Router } from 'express';
import prisma from '../../../database/prisma';
import { requireGuildPermission } from '../../middleware/auth';
import { logAuditDb } from '../../../utils/logger';
import { emitGuildEvent } from '../../socket/emitter';

export const economyRewardsRouter = Router({ mergeParams: true });

const MAX_REWARD_AMOUNT = 1_000_000_000_000_000n;
const MAX_REWARD_COOLDOWN_SECONDS = 86_400;

type RewardTarget = 'WALLET' | 'BANK';

function target(value: unknown): RewardTarget | null {
  return value === 'WALLET' || value === 'BANK' ? value : null;
}

function bigintValue(value: unknown, field: string, allowNull = false): bigint | null {
  if (allowNull && (value === null || value === '')) return null;
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') {
    throw new Error(`${field} muss eine ganze Zahl sein.`);
  }
  let parsed: bigint;
  try { parsed = BigInt(value); }
  catch { throw new Error(`${field} ist nicht parsebar.`); }
  if (parsed < 0n || parsed > MAX_REWARD_AMOUNT) {
    throw new Error(`${field} muss zwischen 0 und ${MAX_REWARD_AMOUNT.toString()} liegen.`);
  }
  return parsed;
}

async function payload(guildId: string, nitradoConnId: string) {
  const [settings, slot, pvp, playtime] = await Promise.all([
    prisma.serverSettings.findUnique({
      where: { guildId_nitradoConnId: { guildId, nitradoConnId } },
      select: { economyActive: true },
    }),
    prisma.economySlotConfig.findUnique({
      where: { guildId_nitradoConnId: { guildId, nitradoConnId } },
      select: { admRewardsEnabled: true, rewardTarget: true, timezone: true },
    }),
    prisma.economyRewardRule.findUnique({
      where: { guildId_nitradoConnId_ruleKey: { guildId, nitradoConnId, ruleKey: 'pvp:default' } },
      select: { enabled: true, baseAmount: true, rewardTarget: true, dailyCap: true, cooldownSeconds: true },
    }),
    prisma.economyRewardRule.findUnique({
      where: { guildId_nitradoConnId_ruleKey: { guildId, nitradoConnId, ruleKey: 'playtime:default' } },
      select: { enabled: true, baseAmount: true, rewardTarget: true },
    }),
  ]);

  const fallbackTarget: RewardTarget = slot?.rewardTarget ?? 'WALLET';
  return {
    economyActive: settings?.economyActive === true,
    admRewardsEnabled: slot?.admRewardsEnabled === true,
    timezone: slot?.timezone ?? 'Europe/Berlin',
    pvp: {
      enabled: pvp?.enabled === true,
      baseAmount: (pvp?.baseAmount ?? 0n).toString(),
      rewardTarget: pvp?.rewardTarget ?? fallbackTarget,
      dailyCap: pvp?.dailyCap?.toString() ?? null,
      cooldownSeconds: pvp?.cooldownSeconds ?? 0,
    },
    playtime: {
      enabled: playtime?.enabled === true,
      baseAmount: (playtime?.baseAmount ?? 0n).toString(),
      rewardTarget: playtime?.rewardTarget ?? fallbackTarget,
    },
  };
}

economyRewardsRouter.get('/', requireGuildPermission('economy.view'), async (req, res) => {
  const scope = req.guildScope!;
  const connId = scope.nitradoConnId!;
  res.json({ nitradoConnId: connId, ...(await payload(scope.guildId, connId)) });
});

economyRewardsRouter.put('/', requireGuildPermission('economy.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const connId = scope.nitradoConnId!;
  const body = req.body ?? {};
  const hasMaster = Object.prototype.hasOwnProperty.call(body, 'admRewardsEnabled');
  const hasPvp = body.pvp !== undefined;
  const hasPlaytime = body.playtime !== undefined;
  if (!hasMaster && !hasPvp && !hasPlaytime) {
    res.status(400).json({ error: 'Keine gueltigen Reward-Felder.' });
    return;
  }
  if (hasMaster && typeof body.admRewardsEnabled !== 'boolean') {
    res.status(400).json({ error: 'admRewardsEnabled muss boolean sein.' });
    return;
  }
  if (hasPvp && (!body.pvp || typeof body.pvp !== 'object' || Array.isArray(body.pvp))) {
    res.status(400).json({ error: 'pvp muss ein Objekt sein.' });
    return;
  }
  if (hasPlaytime && (!body.playtime || typeof body.playtime !== 'object' || Array.isArray(body.playtime))) {
    res.status(400).json({ error: 'playtime muss ein Objekt sein.' });
    return;
  }

  const [settings, slotCurrent, pvpCurrent, playtimeCurrent] = await Promise.all([
    prisma.serverSettings.findUnique({
      where: { guildId_nitradoConnId: { guildId: scope.guildId, nitradoConnId: connId } },
      select: { economyActive: true },
    }),
    prisma.economySlotConfig.findUnique({
      where: { guildId_nitradoConnId: { guildId: scope.guildId, nitradoConnId: connId } },
      select: { enabled: true, admRewardsEnabled: true, rewardTarget: true, timezone: true },
    }),
    prisma.economyRewardRule.findUnique({
      where: { guildId_nitradoConnId_ruleKey: { guildId: scope.guildId, nitradoConnId: connId, ruleKey: 'pvp:default' } },
    }),
    prisma.economyRewardRule.findUnique({
      where: { guildId_nitradoConnId_ruleKey: { guildId: scope.guildId, nitradoConnId: connId, ruleKey: 'playtime:default' } },
    }),
  ]);

  const fallbackTarget: RewardTarget = slotCurrent?.rewardTarget ?? 'WALLET';
  const pvpBody = (hasPvp ? body.pvp : {}) as Record<string, unknown>;
  const playtimeBody = (hasPlaytime ? body.playtime : {}) as Record<string, unknown>;

  let pvpEnabled = pvpCurrent?.enabled ?? false;
  let pvpAmount = pvpCurrent?.baseAmount ?? 0n;
  let pvpTarget: RewardTarget = pvpCurrent?.rewardTarget ?? fallbackTarget;
  let pvpDailyCap = pvpCurrent?.dailyCap ?? null;
  let pvpCooldown = pvpCurrent?.cooldownSeconds ?? 0;

  try {
    if (Object.prototype.hasOwnProperty.call(pvpBody, 'enabled')) {
      if (typeof pvpBody.enabled !== 'boolean') throw new Error('pvp.enabled muss boolean sein.');
      pvpEnabled = pvpBody.enabled;
    }
    if (Object.prototype.hasOwnProperty.call(pvpBody, 'baseAmount')) {
      pvpAmount = bigintValue(pvpBody.baseAmount, 'pvp.baseAmount') ?? 0n;
    }
    if (Object.prototype.hasOwnProperty.call(pvpBody, 'rewardTarget')) {
      const parsedTarget = target(pvpBody.rewardTarget);
      if (!parsedTarget) throw new Error('pvp.rewardTarget muss WALLET oder BANK sein.');
      pvpTarget = parsedTarget;
    }
    if (Object.prototype.hasOwnProperty.call(pvpBody, 'dailyCap')) {
      const cap = bigintValue(pvpBody.dailyCap, 'pvp.dailyCap', true);
      pvpDailyCap = cap === 0n ? null : cap;
    }
    if (Object.prototype.hasOwnProperty.call(pvpBody, 'cooldownSeconds')) {
      if (typeof pvpBody.cooldownSeconds !== 'number' || !Number.isInteger(pvpBody.cooldownSeconds)
        || pvpBody.cooldownSeconds < 0 || pvpBody.cooldownSeconds > MAX_REWARD_COOLDOWN_SECONDS) {
        throw new Error(`pvp.cooldownSeconds muss 0..${MAX_REWARD_COOLDOWN_SECONDS} sein.`);
      }
      pvpCooldown = pvpBody.cooldownSeconds;
    }
    if (pvpEnabled && pvpAmount <= 0n) {
      throw new Error('Aktive PvP-Rewards brauchen einen Betrag groesser 0.');
    }
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
    return;
  }

  let playtimeTarget: RewardTarget = playtimeCurrent?.rewardTarget ?? fallbackTarget;
  if (Object.prototype.hasOwnProperty.call(playtimeBody, 'rewardTarget')) {
    const parsedTarget = target(playtimeBody.rewardTarget);
    if (!parsedTarget) {
      res.status(400).json({ error: 'playtime.rewardTarget muss WALLET oder BANK sein.' });
      return;
    }
    playtimeTarget = parsedTarget;
  }

  await prisma.$transaction(async tx => {
    if (hasMaster) {
      const economyActive = settings?.economyActive === true;
      await tx.economySlotConfig.upsert({
        where: { guildId_nitradoConnId: { guildId: scope.guildId, nitradoConnId: connId } },
        create: {
          guildId: scope.guildId,
          nitradoConnId: connId,
          enabled: economyActive,
          admRewardsEnabled: body.admRewardsEnabled,
        },
        update: { admRewardsEnabled: body.admRewardsEnabled },
      });
    }

    if (hasPvp) {
      await tx.economyRewardRule.upsert({
        where: { guildId_nitradoConnId_ruleKey: { guildId: scope.guildId, nitradoConnId: connId, ruleKey: 'pvp:default' } },
        create: {
          guildId: scope.guildId,
          nitradoConnId: connId,
          ruleKey: 'pvp:default',
          eventType: 'PLAYER_KILLED',
          enabled: pvpEnabled,
          baseAmount: pvpAmount,
          rewardTarget: pvpTarget,
          dailyCap: pvpDailyCap,
          cooldownSeconds: pvpCooldown,
        },
        update: {
          enabled: pvpEnabled,
          baseAmount: pvpAmount,
          rewardTarget: pvpTarget,
          dailyCap: pvpDailyCap,
          cooldownSeconds: pvpCooldown,
        },
      });
    }

    if (hasPlaytime) {
      await tx.economyRewardRule.upsert({
        where: { guildId_nitradoConnId_ruleKey: { guildId: scope.guildId, nitradoConnId: connId, ruleKey: 'playtime:default' } },
        create: {
          guildId: scope.guildId,
          nitradoConnId: connId,
          ruleKey: 'playtime:default',
          enabled: false,
          baseAmount: 0n,
          rewardTarget: playtimeTarget,
        },
        update: { rewardTarget: playtimeTarget },
      });
    }
  });

  logAuditDb('ECONOMY_REWARDS_UPDATED', 'ECONOMY', {
    actorUserId: req.auth!.userId,
    guildId: scope.guildId,
    details: {
      nitradoConnId: connId,
      fields: [hasMaster ? 'admRewardsEnabled' : null, hasPvp ? 'pvp' : null, hasPlaytime ? 'playtime' : null].filter(Boolean),
    },
  });
  emitGuildEvent(scope.guildId, { type: 'settings.changed', payload: { guildId: scope.guildId, slotId: connId } });
  res.json({ nitradoConnId: connId, ...(await payload(scope.guildId, connId)) });
});
