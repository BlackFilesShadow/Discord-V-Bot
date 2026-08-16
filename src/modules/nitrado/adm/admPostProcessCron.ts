/**
 * ADM-V2 Postprocessor.
 *
 * Datei-Download/Parsing gehoert ausschliesslich dem inkrementellen Live-Ingest.
 * Dieser Cron arbeitet nur noch auf der kanonischen AdmEvent-Source-of-Truth
 * und uebernimmt PvP-Rewards, PlayerSessions und Spielzeit-Rewards.
 */

import prisma from '../../../database/prisma';
import { config } from '../../../config';
import { logger } from '../../../utils/logger';
import { asGuildId, asNitradoConnId } from '../../../types/scope';
import { runPvpRewardShadow, type RewardEngineClient } from './rewardEngine';
import { aggregatePlayerSessions, type PlayerSessionClient } from './playerSessionService';
import { getRewardRule, effectiveBaseAmount, type RewardRuleClient } from '../../economy/rewardRules';
import { getSlotEconomyConfig, admRewardsActive, type SlotConfigClient } from '../../economy/slotConfig';
import { bookPendingRewards, type RewardBookingClient } from '../../economy/rewardBooking';
import { bookPlaytimeRewards, type PlaytimeBookingClient } from '../../economy/playtimeBooking';
import { assertEconomyScopeReady } from '../../economy/scopeMigration';
import { resolveRewardIdentity, resolveRewardUserAt } from '../../linking/linkRewards';

const INTERVAL_MS = 60_000;
let timer: NodeJS.Timeout | null = null;
let running = false;

interface ScopedConnection {
  id: string;
  guildId: string;
}

async function processConnection(conn: ScopedConnection): Promise<void> {
  const scopeRef = { guildId: conn.guildId, nitradoConnId: conn.id };

  try {
    await aggregatePlayerSessions(prisma as unknown as PlayerSessionClient, scopeRef);
  } catch (error) {
    logger.warn(`ADM-Postprocess: PlayerSession-Aggregation fehlgeschlagen fuer ${conn.id}: ${(error as Error).message}`);
  }

  try {
    await assertEconomyScopeReady(asGuildId(conn.guildId), asNitradoConnId(conn.id));
  } catch (error) {
    logger.debug(`ADM-Postprocess: Economy fuer ${conn.guildId}/${conn.id} noch nicht scope-ready: ${(error as Error).message}`);
    return;
  }

  try {
    const slotCfg = await getSlotEconomyConfig(prisma as unknown as SlotConfigClient, scopeRef);
    const active = admRewardsActive(slotCfg);
    const pvpRule = await getRewardRule(prisma as unknown as RewardRuleClient, scopeRef, 'pvp:default');
    const resolveUserAt = (gameId: string, occurredAt: Date | null) => resolveRewardUserAt(
      scopeRef,
      gameId,
      occurredAt,
      config.security.encryptionKey,
    );
    const resolvePlaytimeLink = (gameId: string) => resolveRewardIdentity(
      scopeRef,
      gameId,
      config.security.encryptionKey,
    );

    await runPvpRewardShadow(
      prisma as unknown as RewardEngineClient,
      scopeRef,
      {
        rewardRuleId: 'pvp:default',
        baseAmount: active ? effectiveBaseAmount(pvpRule) : 0n,
      },
      resolveUserAt,
    );

    if (active && slotCfg) {
      await bookPendingRewards(
        prisma as unknown as RewardBookingClient,
        scopeRef,
        { rewardTarget: slotCfg.rewardTarget },
      );

      const playtimeRule = await getRewardRule(
        prisma as unknown as RewardRuleClient,
        scopeRef,
        'playtime:default',
      );
      await bookPlaytimeRewards(
        prisma as unknown as PlaytimeBookingClient,
        scopeRef,
        {
          perBucketAmount: effectiveBaseAmount(playtimeRule),
          rewardTarget: slotCfg.rewardTarget,
        },
        resolvePlaytimeLink,
      );
    }
  } catch (error) {
    logger.warn(`ADM-Postprocess: Reward-Verarbeitung fehlgeschlagen fuer ${conn.id}: ${(error as Error).message}`);
  }
}

export async function runAdmPostProcessOnce(): Promise<void> {
  if (running) return;
  running = true;
  try {
    // eslint-disable-next-line local/no-unscoped-prisma-query -- globaler Scheduler-Sweep; jede Folgeoperation ist Guild+Connection scoped.
    const connections = await prisma.nitradoConnection.findMany({
      where: { status: 'ACTIVE', nitradoServerId: { not: null } },
      select: { id: true, guildId: true },
    });
    for (const connection of connections) await processConnection(connection);
  } catch (error) {
    logger.error('ADM-V2-Postprocess Fehler:', error as Error);
  } finally {
    running = false;
  }
}

export function startAdmPostProcessCron(): void {
  if (timer) return;
  logger.info(`ADM-V2-Postprocess gestartet (Intervall ${INTERVAL_MS / 1000}s).`);
  timer = setInterval(() => { void runAdmPostProcessOnce(); }, INTERVAL_MS);
  timer.unref?.();
  void runAdmPostProcessOnce();
}

export function stopAdmPostProcessCron(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
